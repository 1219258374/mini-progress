import { createScopedThreejs } from 'threejs-miniprogram'

let THREE;
let canvas;
let scene, camera, renderer, particleSystem;
let mouse = { x: -100, y: -100 };
let target = { x: 0, y: 0 };
let energy = 0, isInteracting = false;
let currentMode = 'NEBULA';

// Reduced density to ensure smooth playback on mobile mini-programs
const particleCount = 2000;
let positions, velocities, colors, orbitRadii, phase;
let reqId;
let gravity = { x: 0, y: 0 };
let vortexCharge = 0;
let justReleased = false;
let lineSystem = null; // THREE.LineSegments for constellation
let linePositions = null;
let particleLife = null; // Float32Array for LIGHT_PAINT fade timers
let paintIndex = 0; // Round-robin cursor for spawning paint particles

Page({
  data: {
    currentMode: 'NEBULA',
    progNum: 0,
    energy: 0,
    showDiag: false,
    resId: '',
    showPalette: false,
    customHue: 220,
    customBright: 50,
    customSize: 50
  },

  onLoad(options) {
    mouse = { x: 0, y: 0 };
    target = { x: 0, y: 0 };
    energy = 0;
    isInteracting = false;
    wx.createSelectorQuery().select('#webgl').node().exec((res) => {
      const node = res[0].node;
      this._initWebGL(node);
    });

    // Start listening to Accelerometer for Gravity Effect (Interval: ui = ~16ms)
    wx.startAccelerometer({
      interval: 'ui',
      success: () => {
        wx.onAccelerometerChange((res) => {
          // Flattening real-world 3D gravity into our 2D screen coordinate system
          // res.x is left-right (-1 to 1), res.y is bottom-top (-1 to 1)
          gravity.x = res.x * 0.15; 
          gravity.y = res.y * 0.15;
        });
      }
    });
  },

  onUnload() {
    if (renderer) {
      if (canvas) canvas.cancelAnimationFrame(reqId);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement = null;
      renderer = null;
    }
    wx.stopAccelerometer();
    wx.offAccelerometerChange();
    THREE = null;
  },

  _createTexture() {
    // In miniprogram, offscreen canvas creates compatibility issues for texture generation. 
    // Creating a procedural soft circle using a basic canvas context isn't directly supported by threejs-miniprogram without explicit adapter bridges. 
    // To ensure 100% stability, we'll rely on blending modes and dot representations natively.
    // Particle size attenuation + additive blending gives a solid alternative.
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - 32;
        const dy = y - 32;
        const dist = Math.sqrt(dx * dx + dy * dy) / 32;
        let r = 0, g = 0, b = 0, a = 0;
        if (dist <= 1) {
          if (dist <= 0.1) {
            const t = dist / 0.1;
            r = 255 + t * (100 - 255); g = 255 + t * (200 - 255); b = 255; a = 1.0 + t * (0.8 - 1.0);
          } else if (dist <= 0.3) {
            const t = (dist - 0.1) / 0.2;
            r = 100 + t * (0 - 100); g = 200 + t * (100 - 200); b = 255; a = 0.8 + t * (0.2 - 0.8);
          } else {
            const t = (dist - 0.3) / 0.7;
            r = 0; g = 100 + t * (0 - 100); b = 255 + t * (0 - 255); a = 0.2 + t * (0.0 - 0.2);
          }
        }
        const i = (y * size + x) * 4;
        data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = a * 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  },

  _initWebGL(node) {
    canvas = node;
    THREE = createScopedThreejs(canvas);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const info = wx.getSystemInfoSync();
    renderer.setPixelRatio(Math.min(info.pixelRatio, 2));
    renderer.setSize(canvas.width, canvas.height);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, canvas.width / canvas.height, 0.1, 1000);
    camera.position.z = 6;

    const geometry = new THREE.BufferGeometry();
    positions = new Float32Array(particleCount * 3);
    velocities = new Float32Array(particleCount * 3);
    colors = new Float32Array(particleCount * 3);
    orbitRadii = new Float32Array(particleCount);
    phase = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 5;
      orbitRadii[i] = 0.8 + Math.pow(Math.random(), 2) * 3.5;
      phase[i] = Math.random() * Math.PI * 2;

      const color = new THREE.Color().setHSL(0.6, 0.8, 0.5);
      colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
    }

    geometry.addAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.addAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Instead of simple PointsMaterial, we use a custom ShaderMaterial to allow velocity stretching for Meteors
    const uniforms = {
      pointTexture: { value: this._createTexture() },
      isMeteor: { value: 0.0 },
      gravityAngle: { value: -Math.PI / 2 },
      particleSize: { value: 4.0 }
    };

    const vertexShader = `
      attribute vec3 color;
      varying vec3 vColor;
      uniform float isMeteor;
      uniform float particleSize;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (isMeteor > 0.5 ? 45.0 : particleSize) * (30.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform sampler2D pointTexture;
      uniform float isMeteor;
      uniform float gravityAngle;
      varying vec3 vColor;
      void main() {
        vec4 texColor = texture2D(pointTexture, gl_PointCoord);
        
        if (isMeteor > 0.5) {
            // Rotate UV by gravity angle so the streak follows the tilt direction
            vec2 uv = gl_PointCoord - 0.5;
            float ca = cos(gravityAngle + 1.5708);
            float sa = sin(gravityAngle + 1.5708);
            vec2 ruv = vec2(uv.x * ca - uv.y * sa, uv.x * sa + uv.y * ca);
            
            // Squash perpendicular axis to make a thin line
            ruv.x *= 12.0;
            ruv += 0.5;
            texColor = texture2D(pointTexture, ruv);
            
            // Fade along the streak for comet tail effect
            float along = uv.x * sa + uv.y * ca;
            texColor.a *= smoothstep(0.0, 0.4, 0.5 - along);
        }
        
        gl_FragColor = vec4(vColor, texColor.a * 0.8);
      }
    `;

    const material = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      transparent: true
    });

    particleSystem = new THREE.Points(geometry, material);
    scene.add(particleSystem);

    // Constellation line system (max 3000 line segments = 6000 vertices)
    const maxLines = 3000;
    linePositions = new Float32Array(maxLines * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.addAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending
    });
    lineSystem = new THREE.LineSegments(lineGeo, lineMat);
    lineSystem.visible = false;
    scene.add(lineSystem);

    // Life timers for LIGHT_PAINT
    particleLife = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) particleLife[i] = -1; // -1 = not in paint mode

    this._animate();
  },

  setTheme(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ currentMode: mode });
    currentMode = mode;

    const hues = { NEBULA: 0.6, RIPPLE: 0.55, SOLAR: 0.5, FINGER_VORTEX: 0.8, CONSTELLATION: 0.65, LIGHT_PAINT: 0.0 };
    if (particleSystem) {
      const posAttr = particleSystem.geometry.attributes.position;
      const colorAttr = particleSystem.geometry.attributes.color;
      const newCol = new THREE.Color().setHSL(hues[mode] || 0.6, 0.9, 0.5);

      // When leaving LIGHT_PAINT, particles are at z=-100 and need full reset
      const needsReset = (mode !== 'LIGHT_PAINT') && particleLife && particleLife[0] !== -1;

      for (let i = 0; i < particleCount; i++) {
        colorAttr.array[i * 3] = newCol.r; colorAttr.array[i * 3 + 1] = newCol.g; colorAttr.array[i * 3 + 2] = newCol.b;
        
        if (needsReset) {
          posAttr.array[i*3]   = (Math.random() - 0.5) * 20;
          posAttr.array[i*3+1] = (Math.random() - 0.5) * 20;
          posAttr.array[i*3+2] = (Math.random() - 0.5) * 5;
          velocities[i*3] = 0; velocities[i*3+1] = 0;
          particleLife[i] = -1;
        }
      }
      colorAttr.needsUpdate = true;
      if (needsReset) posAttr.needsUpdate = true;
      particleSystem.material.uniforms.isMeteor.value = 0.0;
    }

    // Show constellation lines only in CONSTELLATION mode
    if (lineSystem) lineSystem.visible = (mode === 'CONSTELLATION');

    // Reset paint particles when entering LIGHT_PAINT
    if (mode === 'LIGHT_PAINT' && particleLife) {
      const posAttr = particleSystem.geometry.attributes.position;
      const colorAttr = particleSystem.geometry.attributes.color;
      for (let i = 0; i < particleCount; i++) {
        particleLife[i] = 0;
        posAttr.array[i*3]   = 9999;
        posAttr.array[i*3+1] = 9999;
        posAttr.array[i*3+2] = 9999;
        colorAttr.array[i*3] = 0; colorAttr.array[i*3+1] = 0; colorAttr.array[i*3+2] = 0;
      }
      posAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
      paintIndex = 0;
    }
  },

  _animate() {
    if (!renderer || !particleSystem) return;
    reqId = canvas.requestAnimationFrame(() => this._animate());

    target.x += (mouse.x - target.x) * 0.05;
    target.y += (mouse.y - target.y) * 0.05;

    const posAttr = particleSystem.geometry.attributes.position;
    const colorAttr = particleSystem.geometry.attributes.color;
    const time = Date.now() * 0.001;

    for (let i = 0; i < particleCount; i++) {
      const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
      const dx = target.x - posAttr.array[ix], dy = target.y - posAttr.array[iy];
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      if (currentMode === 'NEBULA') {
        const error = dist - orbitRadii[i];
        velocities[ix] += Math.cos(angle) * error * 0.0025;
        velocities[iy] += Math.sin(angle) * error * 0.0025;
      }
      else if (currentMode === 'RIPPLE') {
        const wave = Math.sin(dist * 2 - time * 5) * 0.02;
        posAttr.array[iz] += (wave - posAttr.array[iz]) * 0.1;
        const push = Math.max(0, (1.5 - dist) * 0.005);
        velocities[ix] -= Math.cos(angle) * push;
        velocities[iy] -= Math.sin(angle) * push;
      }
      else if (currentMode === 'SOLAR') {
        // Particle tornado: strong spiral rotation + distance-based orbit
        const idealDist = 0.5 + orbitRadii[i] * 0.8; // Each particle has its own orbit radius
        const distError = dist - idealDist;
        
        // Pull/push toward ideal orbit distance from finger
        const radialForce = distError * 0.008;
        velocities[ix] += (dx / (dist + 0.01)) * radialForce;
        velocities[iy] += (dy / (dist + 0.01)) * radialForce;
        
        // Strong tangential rotation - creates visible spiral arms
        const spinSpeed = 0.025 / (dist * 0.3 + 0.5);
        velocities[ix] += (-dy / (dist + 0.01)) * spinSpeed;
        velocities[iy] += (dx / (dist + 0.01)) * spinSpeed;
        
        // Touch interaction: tap to scatter outward
        if (isInteracting && dist < 2.0) {
          const scatter = (2.0 - dist) * 0.02;
          velocities[ix] -= (dx / (dist + 0.01)) * scatter;
          velocities[iy] -= (dy / (dist + 0.01)) * scatter;
        }
        
        // Tiny random jitter for organic feel
        velocities[ix] += (Math.random() - 0.5) * 0.005;
        velocities[iy] += (Math.random() - 0.5) * 0.005;
      }
      else if (currentMode === 'FINGER_VORTEX') {
        if (isInteracting) {
          // Slowly build up charge for cinematic gathering
          vortexCharge = Math.min(vortexCharge + 0.005, 1.0);
          
          // Pull dominates orbit so particles actually spiral IN, not orbit forever
          const pullStrength = (0.008 + vortexCharge * 0.015) / (dist * 0.3 + 0.5);
          const orbitStrength = 0.005 + vortexCharge * 0.008;
          
          // Pull toward finger (always active, no dead zone)
          velocities[ix] += (dx / (dist + 0.01)) * pullStrength;
          velocities[iy] += (dy / (dist + 0.01)) * pullStrength;
          
          // Gentle perpendicular orbit only at medium distance for spiral effect
          if (dist > 0.5 && dist < 6.0) {
            velocities[ix] += (-dy / dist) * orbitStrength;
            velocities[iy] += (dx / dist) * orbitStrength;
          }
        } else if (justReleased) {
          // EXPLODE: fling particles outward from where the finger was
          const explosionForce = 0.3 + vortexCharge * 0.5;
          if (dist > 0.01 && dist < 8.0) {
            velocities[ix] -= (dx / dist) * explosionForce * (1.0 / (dist * 0.5 + 0.5));
            velocities[iy] -= (dy / dist) * explosionForce * (1.0 / (dist * 0.5 + 0.5));
          }
        } else {
          // Idle: gentle random drift
          velocities[ix] += (Math.random() - 0.5) * 0.003;
          velocities[iy] += (Math.random() - 0.5) * 0.003;
        }
      }
      else if (currentMode === 'CONSTELLATION') {
        // Scatter randomly across screen, flatten Z, gentle drift
        posAttr.array[iz] += (0 - posAttr.array[iz]) * 0.1; // flatten to Z=0
        velocities[ix] += (Math.random() - 0.5) * 0.001;
        velocities[iy] += (Math.random() - 0.5) * 0.001;
        velocities[ix] *= 0.96; velocities[iy] *= 0.96;
        
        // Keep particles on screen
        if (posAttr.array[ix] < -8) velocities[ix] += 0.01;
        if (posAttr.array[ix] > 8) velocities[ix] -= 0.01;
        if (posAttr.array[iy] < -10) velocities[iy] += 0.01;
        if (posAttr.array[iy] > 10) velocities[iy] -= 0.01;
        
        // Brighten particles near finger
        if (isInteracting && dist < 4.0) {
          const glow = 1.0 - dist / 4.0;
          const glowColor = new THREE.Color().setHSL(this.data.customHue / 360, 0.9, 0.3 + glow * 0.6);
          colorAttr.array[ix] = glowColor.r; colorAttr.array[ix+1] = glowColor.g; colorAttr.array[ix+2] = glowColor.b;
        }
      }
      else if (currentMode === 'LIGHT_PAINT') {
        // Particles with life > 0 are active paint splashes
        if (particleLife[i] > 0) {
          particleLife[i] -= 0.008; // Fade over ~2 seconds
          
          // Slight downward drift + spread
          velocities[iy] -= 0.002;
          velocities[ix] *= 0.97; velocities[iy] *= 0.97;
          
          posAttr.array[ix] += velocities[ix];
          posAttr.array[iy] += velocities[iy];
          
          // Fade color alpha by reducing brightness
          const life = Math.max(0, particleLife[i]);
          const paintColor = new THREE.Color().setHSL(this.data.customHue / 360, 0.9, life * 0.7 + 0.1);
          colorAttr.array[ix] = paintColor.r; colorAttr.array[ix+1] = paintColor.g; colorAttr.array[ix+2] = paintColor.b;
          
          if (particleLife[i] <= 0) {
            posAttr.array[ix] = 9999; // Move completely out of frustum
            posAttr.array[iy] = 9999;
            posAttr.array[iz] = 9999;
            colorAttr.array[ix] = 0; colorAttr.array[ix+1] = 0; colorAttr.array[ix+2] = 0;
          }
        } else {
          // Dead paint particles: skip all general physics below
          continue;
        }
      }

      velocities[ix] *= 0.94; velocities[iy] *= 0.94;
      
      // Global velocity clamp to prevent eye-strain
      const vMag = Math.sqrt(velocities[ix]**2 + velocities[iy]**2);
      const vCap = 0.15;
      if (vMag > vCap) {
        velocities[ix] = (velocities[ix] / vMag) * vCap;
        velocities[iy] = (velocities[iy] / vMag) * vCap;
      }
      
      posAttr.array[ix] += velocities[ix]; posAttr.array[iy] += velocities[iy];

      if (currentMode !== 'RIPPLE' && currentMode !== 'FINGER_VORTEX' && currentMode !== 'CONSTELLATION' && currentMode !== 'LIGHT_PAINT') {
        posAttr.array[iz] += Math.sin(time + phase[i]) * 0.002;
      }

      // Use custom hue/brightness from palette
      const speed = Math.sqrt(velocities[ix] ** 2 + velocities[iy] ** 2);
      const userHue = this.data.customHue / 360;
      const userBright = this.data.customBright / 100;
      const brightness = Math.max(0.15, Math.min(0.65, userBright * 0.5 + speed * 1.5 + 0.1));
      const color = new THREE.Color();
      color.setHSL(userHue + speed * 0.08, 0.9, brightness);
      colorAttr.array[ix] = color.r; colorAttr.array[ix + 1] = color.g; colorAttr.array[ix + 2] = color.b;
    }
    posAttr.needsUpdate = true; colorAttr.needsUpdate = true;

    // Sync particle size uniform from slider
    if (particleSystem) {
      particleSystem.material.uniforms.particleSize.value = 1.0 + (this.data.customSize / 100) * 10.0;
    }

    // Build constellation lines near finger (sparse, like real constellations)
    if (currentMode === 'CONSTELLATION' && lineSystem && isInteracting) {
      let lineIdx = 0;
      const maxLinePairs = 3000;
      const connectRadius = 3.0;
      const maxLineLen = 0.8; // Short connections only
      const nearParticles = [];
      const connCount = new Uint8Array(particleCount); // Track connections per particle
      
      // Collect particles near finger
      for (let i = 0; i < particleCount && nearParticles.length < 80; i++) {
        const px = posAttr.array[i*3], py = posAttr.array[i*3+1];
        const d = Math.sqrt((px - target.x)**2 + (py - target.y)**2);
        if (d < connectRadius) nearParticles.push(i);
      }
      
      // Connect pairs, max 3 lines per particle for sparse pattern
      for (let a = 0; a < nearParticles.length && lineIdx < maxLinePairs; a++) {
        if (connCount[nearParticles[a]] >= 3) continue;
        for (let b = a + 1; b < nearParticles.length && lineIdx < maxLinePairs; b++) {
          if (connCount[nearParticles[b]] >= 3) continue;
          const ia = nearParticles[a] * 3, ib = nearParticles[b] * 3;
          const dd = Math.sqrt((posAttr.array[ia]-posAttr.array[ib])**2 + (posAttr.array[ia+1]-posAttr.array[ib+1])**2);
          if (dd < maxLineLen) {
            linePositions[lineIdx*6]   = posAttr.array[ia];
            linePositions[lineIdx*6+1] = posAttr.array[ia+1];
            linePositions[lineIdx*6+2] = 0;
            linePositions[lineIdx*6+3] = posAttr.array[ib];
            linePositions[lineIdx*6+4] = posAttr.array[ib+1];
            linePositions[lineIdx*6+5] = 0;
            lineIdx++;
            connCount[nearParticles[a]]++;
            connCount[nearParticles[b]]++;
          }
        }
      }
      lineSystem.geometry.setDrawRange(0, lineIdx * 2);
      lineSystem.geometry.attributes.position.needsUpdate = true;
      
      const lc = new THREE.Color().setHSL(this.data.customHue / 360, 0.7, 0.55);
      lineSystem.material.color = lc;
      lineSystem.material.opacity = 0.4;
    } else if (currentMode === 'CONSTELLATION' && lineSystem && !isInteracting) {
      lineSystem.geometry.setDrawRange(0, 0);
    }

    // Clear the justReleased flag after one frame of explosion
    if (justReleased) {
      justReleased = false;
      vortexCharge = 0;
    }

    particleSystem.rotation.z += 0.0001;
    renderer.render(scene, camera);
  },

  _updateMouse(x, y) {
    isInteracting = true;
    const info = wx.getSystemInfoSync();
    mouse.x = (x / info.windowWidth) * 2 - 1;
    mouse.y = -(y / info.windowHeight) * 2 + 1;
    mouse.x *= 7.5; mouse.y *= 5.5;
  },

  touchStart(e) {
    if (e.touches && e.touches.length > 0) {
      this._updateMouse(e.touches[0].clientX, e.touches[0].clientY);
    }
  },

  touchMove(e) {
    if (e.touches && e.touches.length > 0) {
      this._updateMouse(e.touches[0].clientX, e.touches[0].clientY);
      
      // Spray paint particles along finger trail
      if (currentMode === 'LIGHT_PAINT' && particleSystem && particleLife) {
        const posAttr = particleSystem.geometry.attributes.position;
        for (let s = 0; s < 8; s++) { // Spawn 8 particles per frame
          const idx = paintIndex % particleCount;
          paintIndex++;
          posAttr.array[idx*3]   = mouse.x + (Math.random()-0.5) * 0.3;
          posAttr.array[idx*3+1] = mouse.y + (Math.random()-0.5) * 0.3;
          posAttr.array[idx*3+2] = (Math.random()-0.5) * 0.5;
          velocities[idx*3]   = (Math.random()-0.5) * 0.08;
          velocities[idx*3+1] = (Math.random()-0.5) * 0.08 + 0.02;
          particleLife[idx] = 1.0;
        }
        posAttr.needsUpdate = true;
      }
    }
  },

  touchEnd(e) {
    if (currentMode === 'FINGER_VORTEX' && isInteracting && vortexCharge > 0.05) {
      justReleased = true;
    }
    isInteracting = false;
  },

  closeDiag() {
    energy = 0;
    isInteracting = false;
    this.setData({ progNum: 0, showDiag: false });
  },

  payUnlock() {
    wx.showToast({ title: '商业逻辑：支付功能需后端接入', icon: 'none' });
  },

  togglePalette() {
    this.setData({ showPalette: !this.data.showPalette });
  },

  onHueChange(e) {
    this.setData({ customHue: e.detail.value });
  },

  onBrightChange(e) {
    this.setData({ customBright: e.detail.value });
  },

  onSizeChange(e) {
    this.setData({ customSize: e.detail.value });
  }
})
