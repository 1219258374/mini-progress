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
let ripples = [];

Page({
  data: {
    currentMode: 'NEBULA',
    progNum: 0,
    energy: 0,
    showDiag: false,
    resId: ''
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
      isMeteor: { value: 0.0 }
    };

    const vertexShader = `
      attribute vec3 color;
      attribute vec3 velocity;
      varying vec3 vColor;
      uniform float isMeteor;
      void main() {
        vColor = color;
        vec3 pos = position;
        
        // If it's a meteor, stretch the position slightly along its velocity vector
        if (isMeteor > 0.5) {
           // We can't easily stretch a gl_Point into a line purely in vertex shader without geometry shaders,
           // but we CAN offset it based on the camera angle or rely on an elongated aspect ratio.
           // For a lightweight Mini Program, a custom texture or simulated tail is better, 
           // but given limitations, we will make the points larger and rely on the high fall speed to create Persistence of Vision (PoV) streaks,
           // combined with a slightly lower opacity additive blend.
        }

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        
        // Size attenuation: Meteors are much larger to allow rendering a long tail
        gl_PointSize = (isMeteor > 0.5 ? 45.0 : 4.0) * (30.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform sampler2D pointTexture;
      uniform float isMeteor;
      varying vec3 vColor;
      void main() {
        vec4 texColor = texture2D(pointTexture, gl_PointCoord);
        
        // If it's a meteor, we manually shape the texture coordinates in the fragment shader to look like a long streak
        if (isMeteor > 0.5) {
            // Elongate the dot into a long streak based on Y axis (falling down)
            vec2 uv = gl_PointCoord;
            uv.x = (uv.x - 0.5) * 15.0 + 0.5; // squash horizontally severely to make a thin line
            texColor = texture2D(pointTexture, uv);
            
            // Fade the tail (top part of the point) to simulate a comet/meteor streak
            texColor.a *= smoothstep(0.0, 0.5, 1.0 - gl_PointCoord.y);
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

    this._animate();
  },

  setTheme(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ currentMode: mode });
    currentMode = mode;

    const hues = { NEBULA: 0.6, RIPPLE: 0.55, SOLAR: 0.5, METEOR_SHOWER: 0.1, LIQUID_WAVE: 0.48 };
    if (particleSystem) {
      const colorAttr = particleSystem.geometry.attributes.color;
      const newCol = new THREE.Color().setHSL(hues[mode], 0.9, 0.5);
      for (let i = 0; i < particleCount; i++) {
        colorAttr.array[i * 3] = newCol.r; colorAttr.array[i * 3 + 1] = newCol.g; colorAttr.array[i * 3 + 2] = newCol.b;
      }
      colorAttr.needsUpdate = true;
      
      // Tell the shader if we are in meteor mode to trigger the streak shaping
      particleSystem.material.uniforms.isMeteor.value = (mode === 'METEOR_SHOWER') ? 1.0 : 0.0;
    }
  },

  _animate() {
    if (!renderer || !particleSystem) return;
    reqId = canvas.requestAnimationFrame(() => this._animate());

    target.x += (mouse.x - target.x) * 0.05;
    target.y += (mouse.y - target.y) * 0.05;

    if (isInteracting && energy < 100) {
      energy += 0.06;
      this.setData({ progNum: Math.floor(energy) });
      if (energy >= 100) {
        this.setData({
          showDiag: true,
          resId: '#BLUE-' + (Math.floor(Math.random() * 8999) + 1000)
        });
      }
    }

    const posAttr = particleSystem.geometry.attributes.position;
    const colorAttr = particleSystem.geometry.attributes.color;
    const time = Date.now() * 0.001;

    // Advance expanding ripples for LIQUID_WAVE
    if (currentMode === 'LIQUID_WAVE') {
      for (let r = ripples.length - 1; r >= 0; r--) {
        ripples[r].time += 0.04; 
        if (ripples[r].time > 3.5) ripples.splice(r, 1); // Fade out after ~3.5s
      }
    }

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
        velocities[ix] += (Math.random() - 0.5) * 0.02;
        velocities[iy] += (Math.random() - 0.5) * 0.02;
        const pull = Math.min(0.008, 0.6 / (dist + 5));
        velocities[ix] += dx * pull;
        velocities[iy] += dy * pull;
      }
      else if (currentMode === 'METEOR_SHOWER') {
        // Only 1 out of 8 particles become meteors to completely fix the "密密麻麻" (dense cluster) issue
        if (i % 8 !== 0) {
           velocities[iy] += (15.0 - posAttr.array[iy]) * 0.1; // Hide them way above screen
           velocities[ix] *= 0.8;
        } else {
           // Fall speed is tied EXACTLY to how much the phone is tilted toward the user.
           // gravity.y is negative when tilted toward the user. If flat, gravity.y ≈ 0.
           const tilt = Math.max(0, -gravity.y); 
           const fallSpeed = tilt * 0.3; // Total stop if flat, very fast if tilted heavily
           
           velocities[ix] += gravity.x * 0.05; // Slight wind drift based on left/right tilt
           velocities[iy] -= fallSpeed;       // Fall only when tilted
           
           // Touch interaction: swipe to scatter meteors
           if (isInteracting && dist < 2.5) {
              velocities[ix] -= (dx / dist) * 0.2;
              velocities[iy] -= (dy / dist) * 0.2;
           }

           // Loop back to top to create endless sparse rain
           if (posAttr.array[iy] < -12) {
              // Huge vertical variance so they spawn irregularly and not in chunks
              posAttr.array[iy] = 12 + Math.random() * 30;
              posAttr.array[ix] = (Math.random() - 0.5) * 25;
              velocities[iy] = 0;
              velocities[ix] = 0;
           }
        }
      }
      else if (currentMode === 'LIQUID_WAVE') {
        const lx = posAttr.array[ix];
        const ly = posAttr.array[iy];
        let targetZ = 0;

        // Force particles into a uniform full-screen grid
        const cols = 40;
        const rows = 50; 
        const targetX = ((i % cols) / cols - 0.5) * 20.0;
        const targetY = -(Math.floor(i / cols) / rows - 0.5) * 30.0;
        
        // Snap strongly to grid so they don't maintain the black-hole circle from Nebula mode
        velocities[ix] += (targetX - lx) * 0.08;
        velocities[iy] += (targetY - ly) * 0.08;

        // Calculate superposition of all active propagating ripples
        for (let r = 0; r < ripples.length; r++) {
           const rip = ripples[r];
           const distToRip = Math.sqrt((lx - rip.x)**2 + (ly - rip.y)**2);
           
           // Wave expands outward
           const waveRadius = rip.time * 8.0; 
           const waveWidth = 2.0; // Thickness of the ripple ring
           const distFromWave = Math.abs(distToRip - waveRadius);
           
           if (distFromWave < waveWidth) {
              // Fade intensity over time
              const intensity = Math.max(0, 1.0 - rip.time / 3.0);
              // Sine wave bump in the ring
              targetZ += Math.sin((1.0 - distFromWave/waveWidth) * Math.PI) * 1.8 * intensity;
           }
        }

        // Smoothly ease Z back to baseline or up to the wave height
        posAttr.array[iz] += (targetZ - posAttr.array[iz]) * 0.12;

        // Strip away X/Y sway so the particles look like a completely static field from above
        velocities[ix] -= velocities[ix] * 0.1;
        velocities[iy] -= velocities[iy] * 0.1;
      }

      velocities[ix] *= 0.94; velocities[iy] *= 0.94;
      posAttr.array[ix] += velocities[ix]; posAttr.array[iy] += velocities[iy];

      if (currentMode !== 'RIPPLE' && currentMode !== 'METEOR_SHOWER' && currentMode !== 'LIQUID_WAVE') {
        posAttr.array[iz] += Math.sin(time + phase[i]) * 0.002;
      }

      const speed = Math.sqrt(velocities[ix] ** 2 + velocities[iy] ** 2);
      const brightness = Math.max(0.3, Math.min(0.9, speed * 25 + 0.4));
      const color = new THREE.Color();
      const baseHue = (currentMode === 'LIQUID_WAVE') ? 0.48 : (currentMode === 'METEOR_SHOWER') ? 0.12 : (currentMode === 'SOLAR') ? 0.5 : 0.62;
      color.setHSL(baseHue + speed * 0.2, 0.85, brightness);
      colorAttr.array[ix] = color.r; colorAttr.array[ix + 1] = color.g; colorAttr.array[ix + 2] = color.b;
    }
    posAttr.needsUpdate = true; colorAttr.needsUpdate = true;
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
      // Drop a new stone in the pond
      if (currentMode === 'LIQUID_WAVE') {
        ripples.push({ x: mouse.x, y: mouse.y, time: 0 });
      }
    }
  },

  touchMove(e) {
    if (e.touches && e.touches.length > 0) this._updateMouse(e.touches[0].clientX, e.touches[0].clientY);
  },

  touchEnd(e) {
    isInteracting = false;
  },

  closeDiag() {
    energy = 0;
    isInteracting = false;
    this.setData({ progNum: 0, showDiag: false });
  },

  payUnlock() {
    wx.showToast({ title: '商业逻辑：支付功能需后端接入', icon: 'none' });
  }
})
