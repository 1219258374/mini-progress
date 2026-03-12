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

Page({
  data: {
    currentMode: 'NEBULA',
    progNum: 0,
    showDiag: false,
    resId: ''
  },

  onReady() {
    wx.createSelectorQuery().select('#webgl').node().exec((res) => {
      const node = res[0].node;
      this._initWebGL(node);
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
    THREE = null;
  },

  _createTexture() {
    // In miniprogram, offscreen canvas creates compatibility issues for texture generation. 
    // Creating a procedural soft circle using a basic canvas context isn't directly supported by threejs-miniprogram without explicit adapter bridges. 
    // To ensure 100% stability, we'll rely on blending modes and dot representations natively.
    // Particle size attenuation + additive blending gives a solid alternative.
    return null;
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

    const material = new THREE.PointsMaterial({
      size: 0.15,
      vertexColors: THREE.VertexColors,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true
    });

    particleSystem = new THREE.Points(geometry, material);
    scene.add(particleSystem);

    this._animate();
  },

  setTheme(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ currentMode: mode });
    currentMode = mode;

    const hues = { NEBULA: 0.6, RIPPLE: 0.55, SOLAR: 0.5 };
    if (particleSystem) {
      const colorAttr = particleSystem.geometry.attributes.color;
      const newCol = new THREE.Color().setHSL(hues[mode], 0.9, 0.5);
      for (let i = 0; i < particleCount; i++) {
        colorAttr.array[i * 3] = newCol.r; colorAttr.array[i * 3 + 1] = newCol.g; colorAttr.array[i * 3 + 2] = newCol.b;
      }
      colorAttr.needsUpdate = true;
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

      velocities[ix] *= 0.94; velocities[iy] *= 0.94;
      posAttr.array[ix] += velocities[ix]; posAttr.array[iy] += velocities[iy];

      if (currentMode !== 'RIPPLE') {
        posAttr.array[iz] += Math.sin(time + phase[i]) * 0.002;
      }

      const speed = Math.sqrt(velocities[ix] ** 2 + velocities[iy] ** 2);
      const brightness = Math.max(0.3, Math.min(0.9, speed * 25 + 0.4));
      const color = new THREE.Color();
      const baseHue = (currentMode === 'SOLAR') ? 0.5 : 0.62;
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
    if (e.touches && e.touches.length > 0) this._updateMouse(e.touches[0].clientX, e.touches[0].clientY);
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
