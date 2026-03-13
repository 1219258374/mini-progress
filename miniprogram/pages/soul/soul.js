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
let lineSystem = null;
let linePositions = null;
let particleLife = null;
let paintIndex = 0;
let lastMouse = { x: 0, y: 0 }; // Track previous finger position for drag velocity

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
    renderer.setClearColor(0x000000, 0); // Transparent so CSS gradient shows through

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

    const hues = { NEBULA: 0.6, RIPPLE: 0.55, TIDAL: 0.5, FINGER_VORTEX: 0.8, FIREWORKS: 0.08, LIGHT_PAINT: 0.0, KALEIDOSCOPE: 0.0, LASER: 0.55, RAIN: 0.58, FLAME: 0.05 };
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

    // Hide line system (no mode uses it anymore)
    if (lineSystem) lineSystem.visible = false;

    // Reset particles for pool-based modes
    if ((mode === 'LIGHT_PAINT' || mode === 'FIREWORKS' || mode === 'KALEIDOSCOPE' || mode === 'LASER') && particleLife) {
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

    // RAIN mode: scatter particles at top of screen
    if (mode === 'RAIN' && particleSystem) {
      const posAttr = particleSystem.geometry.attributes.position;
      for (let i = 0; i < particleCount; i++) {
        posAttr.array[i*3]   = (Math.random() - 0.5) * 16;
        posAttr.array[i*3+1] = -5 + Math.random() * 15;  // Start near/within visible area
        posAttr.array[i*3+2] = (Math.random() - 0.5) * 2;
        velocities[i*3]   = 0;
        velocities[i*3+1] = -(0.02 + Math.random() * 0.04); // Downward speed
        if (particleLife) particleLife[i] = -1; // Mark as non-pool
      }
      posAttr.needsUpdate = true;
    }

    // FLAME mode: spawn particles at bottom
    if (mode === 'FLAME' && particleSystem) {
      const posAttr = particleSystem.geometry.attributes.position;
      for (let i = 0; i < particleCount; i++) {
        posAttr.array[i*3]   = (Math.random() - 0.5) * 3;  // Narrow base
        posAttr.array[i*3+1] = -6 + Math.random() * 8;     // Start within flame area
        posAttr.array[i*3+2] = (Math.random() - 0.5) * 1;
        velocities[i*3]   = 0;
        velocities[i*3+1] = 0.01 + Math.random() * 0.03;   // Upward
        if (particleLife) particleLife[i] = -1;
      }
      posAttr.needsUpdate = true;
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
      else if (currentMode === 'TIDAL') {
        // Breathing/pulse: particles expand and contract rhythmically
        const breathPhase = time * 0.5 + (isInteracting ? Math.PI : 0); // Touch reverses breath
        const breathRadius = 2.0 + Math.sin(breathPhase) * 1.8;
        const idealR = breathRadius * (0.3 + orbitRadii[i] * 0.25);
        
        // Smoothly push/pull toward breathing radius from center
        const centerDist = Math.sqrt(posAttr.array[ix]**2 + posAttr.array[iy]**2);
        const radialError = centerDist - idealR;
        if (centerDist > 0.01) {
          velocities[ix] -= (posAttr.array[ix] / centerDist) * radialError * 0.01;
          velocities[iy] -= (posAttr.array[iy] / centerDist) * radialError * 0.01;
        }
        
        // Slow orbit for visual interest 
        velocities[ix] += (-posAttr.array[iy] / (centerDist + 1)) * 0.002;
        velocities[iy] += (posAttr.array[ix] / (centerDist + 1)) * 0.002;
        
        // Touch scatter: finger pushes nearby particles outward
        if (isInteracting && dist < 3.0) {
          const push = (3.0 - dist) * 0.01;
          velocities[ix] -= (dx / (dist + 0.01)) * push;
          velocities[iy] -= (dy / (dist + 0.01)) * push;
        }
        
        velocities[ix] += (Math.random() - 0.5) * 0.002;
        velocities[iy] += (Math.random() - 0.5) * 0.002;
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
      else if (currentMode === 'FIREWORKS') {
        // Firework particles: burst outward, gravity pull down, fade
        if (particleLife[i] > 0) {
          particleLife[i] -= 0.006; // Fade over ~2.5s
          
          // Gravity
          velocities[iy] -= 0.003;
          // Air drag
          velocities[ix] *= 0.985; velocities[iy] *= 0.985;
          
          posAttr.array[ix] += velocities[ix];
          posAttr.array[iy] += velocities[iy];
          
          // Color: warm hue shift as it fades (gold → orange → red → dim)
          const life = Math.max(0, particleLife[i]);
          const fwHue = this.data.customHue / 360 + (1.0 - life) * 0.05;
          const fwColor = new THREE.Color().setHSL(fwHue, 0.95, life * 0.8 + 0.05);
          colorAttr.array[ix] = fwColor.r; colorAttr.array[ix+1] = fwColor.g; colorAttr.array[ix+2] = fwColor.b;
          
          if (particleLife[i] <= 0) {
            posAttr.array[ix] = 9999;
            posAttr.array[iy] = 9999;
            posAttr.array[iz] = 9999;
            colorAttr.array[ix] = 0; colorAttr.array[ix+1] = 0; colorAttr.array[ix+2] = 0;
          }
        } else {
          // Ambient sparkle (same as LIGHT_PAINT)
          if (Math.random() < 0.0005) {
            posAttr.array[ix] = (Math.random() - 0.5) * 14;
            posAttr.array[iy] = (Math.random() - 0.5) * 18;
            posAttr.array[iz] = 0;
            velocities[ix] = 0; velocities[iy] = 0;
            particleLife[i] = 0.1 + Math.random() * 0.15;
            continue;
          }
          continue;
        }
      }
      else if (currentMode === 'LIGHT_PAINT' || currentMode === 'KALEIDOSCOPE') {
        // Pool-based: active particles fade, dead ones may sparkle
        if (particleLife[i] > 0) {
          particleLife[i] -= (currentMode === 'KALEIDOSCOPE' ? 0.004 : 0.008);
          
          if (currentMode === 'LIGHT_PAINT') {
            velocities[iy] -= 0.002;
          }
          velocities[ix] *= 0.97; velocities[iy] *= 0.97;
          
          posAttr.array[ix] += velocities[ix];
          posAttr.array[iy] += velocities[iy];
          
          const life = Math.max(0, particleLife[i]);
          if (currentMode === 'KALEIDOSCOPE') {
            // Rainbow color based on angle from center
            const pAngle = Math.atan2(posAttr.array[iy], posAttr.array[ix]);
            const rainbowHue = (pAngle / (Math.PI * 2) + 0.5 + time * 0.05) % 1.0;
            const kColor = new THREE.Color().setHSL(rainbowHue, 0.9, life * 0.7 + 0.15);
            colorAttr.array[ix] = kColor.r; colorAttr.array[ix+1] = kColor.g; colorAttr.array[ix+2] = kColor.b;
          } else {
            const paintColor = new THREE.Color().setHSL(this.data.customHue / 360, 0.9, life * 0.7 + 0.1);
            colorAttr.array[ix] = paintColor.r; colorAttr.array[ix+1] = paintColor.g; colorAttr.array[ix+2] = paintColor.b;
          }
          
          if (particleLife[i] <= 0) {
            posAttr.array[ix] = 9999;
            posAttr.array[iy] = 9999;
            posAttr.array[iz] = 9999;
            colorAttr.array[ix] = 0; colorAttr.array[ix+1] = 0; colorAttr.array[ix+2] = 0;
          }
        } else {
          // Ambient fireflies
          if (Math.random() < 0.001) {
            posAttr.array[ix] = (Math.random() - 0.5) * 14;
            posAttr.array[iy] = (Math.random() - 0.5) * 18;
            posAttr.array[iz] = (Math.random() - 0.5) * 0.5;
            velocities[ix] = 0; velocities[iy] = 0;
            particleLife[i] = 0.15 + Math.random() * 0.2;
            continue;
          }
          continue;
        }
      }
      else if (currentMode === 'LASER') {
        // Pool-based: fast-moving laser particles fade
        if (particleLife[i] > 0) {
          particleLife[i] -= 0.004;
          velocities[ix] *= 0.98; velocities[iy] *= 0.98;
          posAttr.array[ix] += velocities[ix];
          posAttr.array[iy] += velocities[iy];
          
          const life = Math.max(0, particleLife[i]);
          const laserColor = new THREE.Color().setHSL(this.data.customHue / 360, 1.0, life * 0.9 + 0.1);
          colorAttr.array[ix] = laserColor.r; colorAttr.array[ix+1] = laserColor.g; colorAttr.array[ix+2] = laserColor.b;
          
          if (particleLife[i] <= 0) {
            posAttr.array[ix] = 9999; posAttr.array[iy] = 9999; posAttr.array[iz] = 9999;
            colorAttr.array[ix] = 0; colorAttr.array[ix+1] = 0; colorAttr.array[ix+2] = 0;
          }
        } else {
          continue;
        }
      }
      else if (currentMode === 'RAIN') {
        // Continuous rain: fall, respawn at top, finger repels
        velocities[iy] -= 0.001; // Gravity
        velocities[ix] += (Math.random() - 0.5) * 0.001; // Slight horizontal drift
        velocities[ix] *= 0.99; velocities[iy] *= 0.995;
        
        // Finger umbrella: repel nearby particles
        if (isInteracting && dist < 2.5) {
          const repel = (2.5 - dist) * 0.015;
          velocities[ix] -= (dx / (dist + 0.01)) * repel;
          velocities[iy] -= (dy / (dist + 0.01)) * repel;
        }
        
        posAttr.array[ix] += velocities[ix];
        posAttr.array[iy] += velocities[iy];
        
        // Respawn at top when below screen
        if (posAttr.array[iy] < -12) {
          posAttr.array[ix] = (Math.random() - 0.5) * 16;
          posAttr.array[iy] = 10 + Math.random() * 2;
          posAttr.array[iz] = (Math.random() - 0.5) * 2;
          velocities[ix] = 0;
          velocities[iy] = -(0.02 + Math.random() * 0.04);
        }
        
        // Color: cool blue with speed glow
        const rainSpeed = Math.abs(velocities[iy]);
        const rainBright = 0.2 + rainSpeed * 3.0;
        const rainColor = new THREE.Color().setHSL(this.data.customHue / 360 || 0.58, 0.7, Math.min(0.55, rainBright));
        colorAttr.array[ix] = rainColor.r; colorAttr.array[ix+1] = rainColor.g; colorAttr.array[ix+2] = rainColor.b;
      }
      else if (currentMode === 'FLAME') {
        // Fire: particles rise from bottom with turbulence
        velocities[iy] += 0.002; // Buoyancy (upward)
        velocities[ix] += (Math.random() - 0.5) * 0.008; // Strong horizontal flicker
        velocities[ix] *= 0.95; velocities[iy] *= 0.98;
        
        // Finger blows flame sideways
        if (isInteracting && dist < 2.0) {
          const blow = (2.0 - dist) * 0.02;
          velocities[ix] -= (dx / (dist + 0.01)) * blow;
          velocities[iy] -= (dy / (dist + 0.01)) * blow * 0.5;
          // Scatter sparks upward
          velocities[iy] += (2.0 - dist) * 0.008;
        }
        
        posAttr.array[ix] += velocities[ix];
        posAttr.array[iy] += velocities[iy];
        
        // Respawn at bottom when above screen or drifted too far
        if (posAttr.array[iy] > 8 || Math.abs(posAttr.array[ix]) > 6) {
          posAttr.array[ix] = (Math.random() - 0.5) * 3;
          posAttr.array[iy] = -6 + Math.random() * 1;
          posAttr.array[iz] = (Math.random() - 0.5) * 1;
          velocities[ix] = 0;
          velocities[iy] = 0.01 + Math.random() * 0.03;
        }
        
        // Color: warm gradient based on height (bottom=red, mid=orange, top=yellow)
        const flameHeight = (posAttr.array[iy] + 6) / 14; // 0 at bottom, 1 at top
        const flameHue = 0.0 + flameHeight * 0.12; // red(0) → orange(0.06) → yellow(0.12)
        const flameBright = 0.3 + (1.0 - flameHeight) * 0.5; // Brighter at bottom
        const flameColor = new THREE.Color().setHSL(flameHue, 1.0, Math.min(0.7, flameBright));
        colorAttr.array[ix] = flameColor.r; colorAttr.array[ix+1] = flameColor.g; colorAttr.array[ix+2] = flameColor.b;
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

      if (currentMode !== 'RIPPLE' && currentMode !== 'FINGER_VORTEX' && currentMode !== 'FIREWORKS' && currentMode !== 'LIGHT_PAINT' && currentMode !== 'KALEIDOSCOPE' && currentMode !== 'LASER' && currentMode !== 'RAIN' && currentMode !== 'FLAME') {
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
    lastMouse.x = mouse.x;
    lastMouse.y = mouse.y;
    const info = wx.getSystemInfoSync();
    // Compute exact visible world-space area from camera frustum
    const fovRad = (75 / 2) * Math.PI / 180; // half FOV in radians
    const halfH = Math.tan(fovRad) * 6; // camera.position.z = 6
    const aspect = info.windowWidth / info.windowHeight;
    const halfW = halfH * aspect;
    mouse.x = ((x / info.windowWidth) * 2 - 1) * halfW;
    mouse.y = (-(y / info.windowHeight) * 2 + 1) * halfH;
  },

  touchStart(e) {
    if (e.touches && e.touches.length > 0) {
      this._updateMouse(e.touches[0].clientX, e.touches[0].clientY);
      
      // FIREWORKS: burst 80 particles from tap point
      if (currentMode === 'FIREWORKS' && particleSystem && particleLife) {
        const posAttr = particleSystem.geometry.attributes.position;
        for (let s = 0; s < 80; s++) {
          const idx = paintIndex % particleCount;
          paintIndex++;
          const burstAngle = Math.random() * Math.PI * 2;
          const burstSpeed = 0.05 + Math.random() * 0.15;
          posAttr.array[idx*3]   = mouse.x + (Math.random()-0.5) * 0.2;
          posAttr.array[idx*3+1] = mouse.y + (Math.random()-0.5) * 0.2;
          posAttr.array[idx*3+2] = (Math.random()-0.5) * 0.3;
          velocities[idx*3]   = Math.cos(burstAngle) * burstSpeed;
          velocities[idx*3+1] = Math.sin(burstAngle) * burstSpeed + 0.03;
          particleLife[idx] = 0.6 + Math.random() * 0.4;
        }
        posAttr.needsUpdate = true;
      }
    }
  },

  touchMove(e) {
    if (e.touches && e.touches.length > 0) {
      this._updateMouse(e.touches[0].clientX, e.touches[0].clientY);
      
      // Spray paint particles along finger trail
      if (currentMode === 'LIGHT_PAINT' && particleSystem && particleLife) {
        const posAttr = particleSystem.geometry.attributes.position;
        for (let s = 0; s < 8; s++) {
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
      
      // KALEIDOSCOPE: 6-fold symmetric particle spray
      if (currentMode === 'KALEIDOSCOPE' && particleSystem && particleLife) {
        const posAttr = particleSystem.geometry.attributes.position;
        const folds = 6;
        for (let s = 0; s < 2; s++) {
          const rx = mouse.x + (Math.random()-0.5) * 0.15;
          const ry = mouse.y + (Math.random()-0.5) * 0.15;
          for (let f = 0; f < folds; f++) {
            const idx = paintIndex % particleCount;
            paintIndex++;
            const rotAngle = (Math.PI * 2 / folds) * f;
            const cos = Math.cos(rotAngle), sin = Math.sin(rotAngle);
            // Mirror: alternate folds flip X
            const mx = (f % 2 === 0) ? rx : -rx;
            posAttr.array[idx*3]   = mx * cos - ry * sin;
            posAttr.array[idx*3+1] = mx * sin + ry * cos;
            posAttr.array[idx*3+2] = 0;
            velocities[idx*3]   = (Math.random()-0.5) * 0.01;
            velocities[idx*3+1] = (Math.random()-0.5) * 0.01;
            particleLife[idx] = 1.0;
          }
        }
        posAttr.needsUpdate = true;
      }
      
      // LASER: tight directional beam along finger movement
      if (currentMode === 'LASER' && particleSystem && particleLife) {
        const posAttr = particleSystem.geometry.attributes.position;
        const dirX = mouse.x - lastMouse.x;
        const dirY = mouse.y - lastMouse.y;
        const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
        if (dirLen > 0.01) {
          const ndx = dirX / dirLen, ndy = dirY / dirLen;
          for (let s = 0; s < 10; s++) {
            const idx = paintIndex % particleCount;
            paintIndex++;
            posAttr.array[idx*3]   = mouse.x + (Math.random()-0.5) * 0.05;
            posAttr.array[idx*3+1] = mouse.y + (Math.random()-0.5) * 0.05;
            posAttr.array[idx*3+2] = 0;
            const speed = 0.05 + Math.random() * 0.05;
            velocities[idx*3]   = ndx * speed + (Math.random()-0.5) * 0.01;
            velocities[idx*3+1] = ndy * speed + (Math.random()-0.5) * 0.01;
            particleLife[idx] = 1.5 + Math.random() * 0.5;
          }
          posAttr.needsUpdate = true;
        }
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
