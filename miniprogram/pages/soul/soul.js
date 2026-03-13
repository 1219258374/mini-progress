import { createScopedThreejs } from 'threejs-miniprogram'

const makeSVG = (paths) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg).replace(/'/g, "%27");
};

const ICONS = {
  NEBULA: makeSVG('<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(45 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-45 12 12)"/><circle cx="12" cy="12" r="2"/>'),
  FIREWORKS: makeSVG('<path d="M12 22V12m0 0l4-4m-4 4l-4-4m4 4l6 2m-6-2l-6 2m6-2l3 5m-3-5l-3 5"/>'),
  RAIN: makeSVG('<path d="M12 22c4 0 6-3 6-7s-6-11-6-11-6 7-6 11 2 7 6 7z"/>'),
  FINGER_VORTEX: makeSVG('<path d="M12 2a10 10 0 100 20 10 10 0 100-20z" stroke-dasharray="4 4"/><circle cx="12" cy="12" r="3"/>'),
  FLAME: makeSVG('<path d="M12 2C10 6 7 9 7 13a5 5 0 0010 0c0-4-3-7-5-11z"/><path d="M12 6c-1 3-3 5-3 8a3 3 0 006 0c0-3-2-5-3-8z"/><path d="M12 10c-.5 1.5-1.5 3-1.5 5a1.5 1.5 0 003 0c0-2-1-3.5-1.5-5z"/>'),
  KALEIDOSCOPE: makeSVG('<path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14"/>'),
  LIGHT_PAINT: makeSVG('<path d="M18.5 5.5l-10 10M2 22l3-3m11-11a2.121 2.121 0 00-3-3L3.5 14.5a2.121 2.121 0 000 3l1.5 1.5a2.121 2.121 0 003 0L19.5 7.5a2.121 2.121 0 000-3l-1-1z"/>'),
  LASER: makeSVG('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7M22 12h-4M12 2v4M12 22v-4M2 12h4"/>'),
  TIDAL: makeSVG('<path d="M2 12c3-3 6-3 9 0s6 3 9 0M2 18c3-3 6-3 9 0s6 3 9 0"/>'),
  RIPPLE: makeSVG('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="11"/>')
};

let THREE;
let canvas;
let scene, camera, renderer, particleSystem;
let mouse = { x: -100, y: -100 };
let target = { x: 0, y: 0 };
let energy = 0, isInteracting = false;
let currentMode = 'NEBULA';

// Total allocated capacity buffer (100%)
const particleCount = 6666;
// Default active particles (30% of 6666 is ~2000)
let activeParticleCount = 2000;
let positions, velocities, colors, orbitRadii, phase;
let reqId;
let vortexCharge = 0;
let justReleased = false;
let lineSystem = null;
let linePositions = null;
let particleLife = null;
let paintIndex = 0;
let lastMouse = { x: 0, y: 0 }; 
let rippleTime = 0;
let rippleOrigin = { x: 0, y: 0 };

// System Info Cache (avoids calling API during 60fps render loop)
let sysWinW = 375, sysWinH = 812, sysPixelRatio = 2;

Page({
  data: {
    icons: ICONS,
    currentMode: 'NEBULA',
    progNum: 0,
    energy: 0,
    showDiag: false,
    resId: '',
    showPalette: false,
    customHue: 220,
    customBright: 50,
    customSize: 50,
    customCount: 30,
    isRackExpanded: true
  },

  onLoad(options) {
    this._initSystemInfo();
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

  _initSystemInfo() {
    try {
      // Modern API first (fails gracefully if undefined)
      if (wx.getWindowInfo && wx.getDeviceInfo) {
        const win = wx.getWindowInfo();
        const dev = wx.getDeviceInfo();
        sysWinW = win.windowWidth || 375;
        sysWinH = win.windowHeight || 812;
        sysPixelRatio = dev.pixelRatio || 2;
      } else {
        // Fallback to deprecated API for older WeChat versions
        const info = wx.getSystemInfoSync();
        sysWinW = info.windowWidth || 375;
        sysWinH = info.windowHeight || 812;
        sysPixelRatio = info.pixelRatio || 2;
      }
    } catch (e) {
      console.warn("Failed to get system info, using defaults.");
    }
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
    renderer.setPixelRatio(Math.min(sysPixelRatio, 2));
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
    // Only render activeParticleCount particles (not the full buffer)
    geometry.setDrawRange(0, activeParticleCount);
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
    // Default hue (degrees) per theme - reset on switch
    const defaultHues = {
      NEBULA: 216, RIPPLE: 240, TIDAL: 175, FINGER_VORTEX: 270,
      FIREWORKS: 35, LIGHT_PAINT: 330, KALEIDOSCOPE: 0,
      LASER: 185, RAIN: 210, FLAME: 15
    };
    const newHueDeg = defaultHues[mode] || 216;
    this.setData({ currentMode: mode, customHue: newHueDeg });
    const previousMode = currentMode; // Save BEFORE overwriting
    currentMode = mode;

    const hues = { NEBULA: 0.6, RIPPLE: 0.67, TIDAL: 0.49, FINGER_VORTEX: 0.75, FIREWORKS: 0.1, LIGHT_PAINT: 0.92, KALEIDOSCOPE: 0.0, LASER: 0.51, RAIN: 0.58, FLAME: 0.04 };
    const needsReset = (mode !== previousMode);
    if (particleSystem) {
      // CLEAR ANY ACCUMULATED ROTATION FROM PREVIOUS MODES
      particleSystem.rotation.x = 0;
      particleSystem.rotation.y = 0;
      particleSystem.rotation.z = 0;
      // Ensure draw range matches active count
      particleSystem.geometry.setDrawRange(0, activeParticleCount);
      
      const posAttr = particleSystem.geometry.attributes.position;
      const colorAttr = particleSystem.geometry.attributes.color;
      const newCol = new THREE.Color().setHSL(hues[mode] || 0.6, 0.9, 0.5);

      for (let i = 0; i < activeParticleCount; i++) {
        colorAttr.array[i * 3] = newCol.r; colorAttr.array[i * 3 + 1] = newCol.g; colorAttr.array[i * 3 + 2] = newCol.b;
        
        if (needsReset) {
          const isPoolMode = (mode === 'LIGHT_PAINT' || mode === 'FIREWORKS' || mode === 'KALEIDOSCOPE' || mode === 'LASER');
          if (isPoolMode) {
            // Pool modes: hide until user touches screen
            posAttr.array[i*3]   = 9999;
            posAttr.array[i*3+1] = 9999;
            posAttr.array[i*3+2] = 9999;
          } else {
            // Physics modes: scatter randomly on screen
            posAttr.array[i*3]   = (Math.random() - 0.5) * 20;
            posAttr.array[i*3+1] = (Math.random() - 0.5) * 20;
            posAttr.array[i*3+2] = (Math.random() - 0.5) * 5;
          }
          velocities[i*3] = 0; velocities[i*3+1] = 0;
          if (particleLife) particleLife[i] = isPoolMode ? 0 : -1;
        }
      }
      colorAttr.needsUpdate = true;
      if (needsReset) posAttr.needsUpdate = true;
      particleSystem.material.uniforms.isMeteor.value = 0.0;
    }

    // Hide line system (no mode uses it anymore)
    if (lineSystem) lineSystem.visible = false;

    // Reset particles for pool-based modes    // Initialize particle arrays (reset everything dead if needed)
    if ((mode === 'LIGHT_PAINT' || mode === 'FIREWORKS' || mode === 'KALEIDOSCOPE' || mode === 'LASER') && particleLife) {
      const posAttr = particleSystem.geometry.attributes.position;
      const colorAttr = particleSystem.geometry.attributes.color;

      // Only reset life counters if transitioning FROM another mode
      if (needsReset) {
        for (let i = 0; i < activeParticleCount; i++) {
          particleLife[i] = 0; // 0 means ready to be spawned

          posAttr.array[i*3]   = 9999;
          posAttr.array[i*3+1] = 9999;
          posAttr.array[i*3+2] = 9999;
          colorAttr.array[i*3] = 0; colorAttr.array[i*3+1] = 0; colorAttr.array[i*3+2] = 0;
        }
        posAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
        paintIndex = 0;
      }
    }

    // NEBULA mode: default random orbits
    if (mode === 'NEBULA' && particleSystem && needsReset) {
      const posAttr = particleSystem.geometry.attributes.position;
      for (let i = 0; i < activeParticleCount; i++) {
        posAttr.array[i*3]   = (Math.random() - 0.5) * 20;
        posAttr.array[i*3+1] = (Math.random() - 0.5) * 20;
        posAttr.array[i*3+2] = (Math.random() - 0.5) * 5;
        velocities[i*3] = 0; velocities[i*3+1] = 0;
      }
      posAttr.needsUpdate = true;
    }

    // TIDAL mode: massive slow spiral
    if (mode === 'TIDAL' && particleSystem) {
      const posAttr = particleSystem.geometry.attributes.position;
      for (let i = 0; i < activeParticleCount; i++) {
        const radius = orbitRadii[i] * 3.0; // wider spread
        const angle = Math.random() * Math.PI * 2;
        posAttr.array[i*3]   = Math.cos(angle) * radius;
        posAttr.array[i*3+1] = Math.sin(angle) * radius;
        posAttr.array[i*3+2] = (Math.random() - 0.5) * 5;
        velocities[i*3] = 0; velocities[i*3+1] = 0;
        if (particleLife) particleLife[i] = -1;
      }
      posAttr.needsUpdate = true;
    }

    // RAIN mode: scatter particles at top of screen
    if (mode === 'RAIN' && particleSystem) {
      const posAttr = particleSystem.geometry.attributes.position;
      for (let i = 0; i < activeParticleCount; i++) {
        posAttr.array[i*3]   = (Math.random() - 0.5) * 16;
        posAttr.array[i*3+1] = -5 + Math.random() * 15;  // Start near/within visible area
        posAttr.array[i*3+2] = (Math.random() - 0.5) * 2;
        velocities[i*3]   = 0;
        velocities[i*3+1] = -(0.02 + Math.random() * 0.04); // Downward speed
        if (particleLife) particleLife[i] = -1; // Mark as non-pool
      }
      posAttr.needsUpdate = true;
    }

    // FLAME mode: spawn uniformly in a cone shape
    if (mode === 'FLAME' && particleSystem) {
      const posAttr = particleSystem.geometry.attributes.position;
      const flameH = 9.0, flameBaseY = -3.5;
      for (let i = 0; i < activeParticleCount; i++) {
        // Uniform distribution over height
        const h = Math.random();
        // Wider at bottom (2.5), holds width longer (1.2 power)
        const maxW = 2.5 * (1.0 - Math.pow(h, 1.2));
        posAttr.array[i*3]   = (Math.random() - 0.5) * maxW * 2;
        posAttr.array[i*3+1] = flameBaseY + h * flameH;
        posAttr.array[i*3+2] = (Math.random() - 0.5) * 0.5;
        // Start with some upward velocity
        velocities[i*3]   = (Math.random() - 0.5) * 0.005;
        velocities[i*3+1] = 0.005 + Math.random() * 0.01;
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

    for (let i = 0; i < activeParticleCount; i++) {
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
        const px = posAttr.array[ix], py = posAttr.array[iy];
        // Calculate distance from the interactive ripple origin
        const rdx = rippleOrigin.x - px;
        const rdy = rippleOrigin.y - py;
        const rDist = Math.sqrt(rdx*rdx + rdy*rdy);
        
        let targetZ = 0;
        
        if (rippleTime > 0) {
          // An expanding ring of influence
          const waveRadius = rippleTime * 8.0; 
          const ringThickness = 1.5;
          const distFromRing = Math.abs(rDist - waveRadius);
          
          if (distFromRing < ringThickness) {
            // Ripple wave function
            const strength = (1.0 - (distFromRing / ringThickness)) * Math.max(0, 1.0 - rippleTime * 0.3);
            targetZ = Math.sin((distFromRing - waveRadius) * 4) * 2.5 * strength;
            
            // X/Y displacement (pushes particles slightly outward then inward)
            velocities[ix] -= (rdx / (rDist + 0.01)) * strength * 0.005;
            velocities[iy] -= (rdy / (rDist + 0.01)) * strength * 0.005;
          }
        }
        
        // Base sine wave over entire field
        const baseWave = Math.sin(dist * 2 - time * 2) * 0.1;
        targetZ += baseWave;
        
        // Spring Z towards target
        posAttr.array[iz] += (targetZ - posAttr.array[iz]) * 0.1;
        
        // Friction and gentle return to original orbit (dist=orbitRadii)
        velocities[ix] *= 0.95; velocities[iy] *= 0.95;
        const radialError = dist - orbitRadii[i];
        velocities[ix] += Math.cos(angle) * radialError * 0.001;
        velocities[iy] += Math.sin(angle) * radialError * 0.001;
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
        continue; // RAIN handles its own physics, skip general update
      }
      else if (currentMode === 'FLAME') {
        const flameBaseY = -3.5, flameH = 9.0, baseX = 0;
        
        const py = posAttr.array[iy];
        const px = posAttr.array[ix];
        
        // Height fraction: 0 at base, 1 at tip
        const relY = py - flameBaseY;
        const heightFrac = Math.max(0, Math.min(1, relY / flameH));
        
        // --- PHYSICS ---
        // Steady upward buoyancy to prevent density gaps
        velocities[iy] += 0.001; 
        
        // Organic horizontal turbulence
        velocities[ix] += (Math.random() - 0.5) * 0.004;
        
        // HARD X-CONSTRAINT: The flame profile is a cone (wide base, narrow top)
        const profileWidth = 2.5 * (1.0 - Math.pow(heightFrac, 1.2));
        
        // Strong pull toward center depending on how far it strayed from the profile
        const distFromCenter = px - baseX;
        velocities[ix] -= distFromCenter * 0.015; // Elastic centering
        
        // Damping
        velocities[ix] *= 0.94; velocities[iy] *= 0.98;
        
        // --- INTERACTION: Smooth Wind Push ---
        // Finger pushes flame away softly, based on 2D distance
        if (isInteracting) {
          const dxFinger = px - mouse.x;
          const dyFinger = py - mouse.y;
          const distToFinger = Math.sqrt(dxFinger*dxFinger + dyFinger*dyFinger);
          
          if (distToFinger < 2.5) {
            // Gentle push, stronger when closer (halved from before)
            const pushForce = (2.5 - distToFinger) * 0.003;
            // Push horizontally away from finger
            velocities[ix] += (dxFinger / (distToFinger + 0.01)) * pushForce;
          }
        }
        
        // Apply velocities
        posAttr.array[ix] += velocities[ix];
        posAttr.array[iy] += velocities[iy];
        
        // Clamp X to absolutely guarantee no drifting beyond the profile
        const currentRelX = posAttr.array[ix] - baseX;
        // Allow slightly more width during interaction to let the wind bend it
        const maxAllowedW = isInteracting ? profileWidth * 1.5 + 1.0 : profileWidth * 1.2 + 0.2;
        if (currentRelX > maxAllowedW) posAttr.array[ix] = baseX + maxAllowedW;
        if (currentRelX < -maxAllowedW) posAttr.array[ix] = baseX - maxAllowedW;
        
        // --- RECYCLE & RESPAWN ---
        // Respawn exactly at base to maintain steady stream
        if (relY > flameH || py < flameBaseY - 1.0) {
          const w = 2.5; // Base width
          posAttr.array[ix] = baseX + (Math.random() - 0.5) * w * 1.5;
          posAttr.array[iy] = flameBaseY + (Math.random() - 0.5) * 0.2;
          posAttr.array[iz] = (Math.random() - 0.5) * 0.5;
          velocities[ix] = (Math.random() - 0.5) * 0.005;
          velocities[iy] = 0.005 + Math.random() * 0.01;
        }
        
        // --- VISUALS ---
        const fadeFactor = Math.max(0, 1.0 - Math.pow(heightFrac, 1.5)); // Fades smoothly near top
        const baseHue = this.data.customHue / 360; // Use user selected color
        const fHue = baseHue + heightFrac * 0.08; // Shift hue slightly as it rises
        const fBright = (0.2 + (1.0 - heightFrac) * 0.6) * fadeFactor;
        const flameColor = new THREE.Color().setHSL(fHue, 1.0, fBright);
        colorAttr.array[ix] = flameColor.r; colorAttr.array[ix+1] = flameColor.g; colorAttr.array[ix+2] = flameColor.b;
        
        continue; // CRITICAL: Stop general physics from breaking it
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

    // Ripple progression
    if (rippleTime > 0) {
      rippleTime += 0.016;
      if (rippleTime > 4.0) rippleTime = 0;
    }

    if (currentMode !== 'FLAME' && currentMode !== 'RAIN' && currentMode !== 'LASER') {
      particleSystem.rotation.z += 0.0001;
    }

    renderer.render(scene, camera);
  },

  _updateMouse(x, y) {
    isInteracting = true;
    lastMouse.x = mouse.x;
    lastMouse.y = mouse.y;
    
    // Compute exact visible world-space area from camera frustum
    const fovRad = (75 / 2) * Math.PI / 180; // half FOV in radians
    const halfH = Math.tan(fovRad) * 6; // camera.position.z = 6
    const aspect = sysWinW / sysWinH;
    const halfW = halfH * aspect;
    mouse.x = ((x / sysWinW) * 2 - 1) * halfW;
    mouse.y = (-(y / sysWinH) * 2 + 1) * halfH;
  },

  touchStart(e) {
    if (e.touches && e.touches.length > 0) {
      this._updateMouse(e.touches[0].clientX, e.touches[0].clientY);
      
      // FIREWORKS: burst 80 particles from tap point
      if (currentMode === 'FIREWORKS' && particleSystem && particleLife) {
        const posAttr = particleSystem.geometry.attributes.position;
        for (let s = 0; s < 80; s++) {
          const idx = paintIndex % activeParticleCount;
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
      
      // RIPPLE: trigger water drop
      if (currentMode === 'RIPPLE') {
        rippleTime = 0.01;
        rippleOrigin.x = mouse.x;
        rippleOrigin.y = mouse.y;
      }
    }
  },

  touchMove(e) {
    if (e.touches && e.touches.length > 0) {
      this._updateMouse(e.touches[0].clientX, e.touches[0].clientY);
      
      // Spray paint particles along finger trail
      if (currentMode === 'LIGHT_PAINT' && particleSystem && particleLife) {
        const posAttr = particleSystem.geometry.attributes.position;
        if (isInteracting) {
          // Spawn multiple particles per frame for continuous stroke
          for (let s = 0; s < 5; s++) {
            const idx = paintIndex % activeParticleCount;
            paintIndex++;
          posAttr.array[idx*3]   = mouse.x + (Math.random()-0.5) * 0.3;
          posAttr.array[idx*3+1] = mouse.y + (Math.random()-0.5) * 0.3;
          posAttr.array[idx*3+2] = (Math.random()-0.5) * 0.5;
          velocities[idx*3]   = (Math.random()-0.5) * 0.08;
          velocities[idx*3+1] = (Math.random()-0.5) * 0.08 + 0.02;
          particleLife[idx] = 1.0;
          }
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
            const idx = paintIndex % activeParticleCount;
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
            const idx = paintIndex % activeParticleCount;
            paintIndex++;
            posAttr.array[idx*3]   = mouse.x + (Math.random()-0.5) * 0.05;
            posAttr.array[idx*3+1] = mouse.y + (Math.random()-0.5) * 0.05;
            posAttr.array[idx*3+2] = 0;
            const speed = 0.15 + Math.random() * 0.1; // Tripled base speed
            velocities[idx*3]   = ndx * speed + (Math.random()-0.5) * 0.01;
            velocities[idx*3+1] = ndy * speed + (Math.random()-0.5) * 0.01;
            particleLife[idx] = 2.0 + Math.random() * 1.0; // Increased lifespan
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

    // LASER: burst explosion
    if (currentMode === 'LASER' && particleSystem && particleLife) {
      const posAttr = particleSystem.geometry.attributes.position;
      for (let s = 0; s < 50; s++) {
        const idx = paintIndex % activeParticleCount;
        paintIndex++;
        posAttr.array[idx*3]   = mouse.x + (Math.random()-0.5) * 0.05;
        posAttr.array[idx*3+1] = mouse.y + (Math.random()-0.5) * 0.05;
        posAttr.array[idx*3+2] = 0;
        const speed = 0.1 + Math.random() * 0.1;
        const angle = Math.random() * Math.PI * 2;
        velocities[idx*3]   = Math.cos(angle) * speed;
        velocities[idx*3+1] = Math.sin(angle) * speed;
        particleLife[idx] = 0.8 + Math.random() * 0.4;
      }
      posAttr.needsUpdate = true;
    }
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

  toggleRack() {
    this.setData({ isRackExpanded: !this.data.isRackExpanded });
  },

  onHueChange(e) {
    this.setData({ customHue: e.detail.value });
  },

  onBrightChange(e) {
    this.setData({ customBright: e.detail.value });
  },

  onSizeChange(e) {
    this.setData({ customSize: e.detail.value });
  },

  onCountChange(e) {
    const val = e.detail.value;
    this.setData({ customCount: val });
    activeParticleCount = Math.floor((val / 100) * particleCount);
    // Ensure at least 10 particles so it doesn't break
    if (activeParticleCount < 10) activeParticleCount = 10;
    
    if (particleSystem) {
      particleSystem.geometry.setDrawRange(0, activeParticleCount);
    }
    // Re-initialize theme to fill the newly active particles properly
    if (val > this.data.customCount) {
       // if we wanted to dynamically resync, we could call setTheme here. 
       // but just letting them flow in naturally is often fine. Right now re-init is safer if density jumps up
       this.setTheme({ currentTarget: { dataset: { mode: currentMode } } });
    }
  }
})
