import { createScopedThreejs } from 'threejs-miniprogram'

const personalityDB = {
  INTJ: { n: '深海潜航的黑鲸', i: '🐋', text: '“孤独是你的声呐。你在无人能及的频率里，构建着沉没的文明。”' },
  INTP: { n: '星云缝隙的猫头鹰', i: '🦉', text: '“逻辑是你的羽翼。你不参与尘世纷争，只在思想高度俯瞰真理。”' },
  ENTJ: { n: '极地巡航的狮王', i: '🦁', text: '“意志是你的疆域。在风暴中心，你不仅是规则的执行者，更是创造者。”' },
  ENTP: { n: '逻辑森林的赤狐', i: '🦊', text: '“混乱是你的养分。你擅长拆解所有的条条框框，将其变成有趣的积木。”' },
  INFJ: { n: '雪山之巅的白鹿', i: '🦌', text: '“你是喧嚣世界里的静默。清醒地看着人群涌动，却只在云端留下轻盈的影。”' },
  INFP: { n: '梦境边缘的独角兽', i: '🦄', text: '“现实太重，你选择在那些不被看见的温柔里呼吸，守护破碎的星辰。”' },
  ENFJ: { n: '晨曦海港的金龙', i: '🐉', text: '“你是光本身。哪怕身处寒冬，你的叙事也能引导疲惫的灵魂游向岛屿。”' },
  ENFP: { n: '极光海洋的白豚', i: '🐬', text: '“世界是你的游乐场。即使在最绝望的频率里，你也能嗅出自由与冒险的味道。”' },
  ISTJ: { n: '岩层深处的守望者', i: '🐢', text: '“秩序是你的鳞甲。沉默是你对时间的最高敬意，你负责承载世界的基石。”' },
  ISFJ: { n: '暖阳之下的巨象', i: '🐘', text: '“你背负着他人的避难所。在细微的温存里，你完成了最沉重的守护。”' },
  ESTJ: { n: '秩序之塔的猎鹰', i: '🦅', text: '“规则是你的航线。任何一丝偏离都难逃你的利眼，你确保星轨不乱。”' },
  ESFJ: { n: '蜜意平原的耕耘者', i: '🐝', text: '“你是连接的纽带。用勤勉织就一张温暖的网络，让所有人都有归处。”' },
  ISTP: { n: '废弃工厂的银狼', i: '🐺', text: '“工具是你的感官。理性的冷酷是你最锋利的刀刃，你只对真实的物理规律着迷。”' },
  ISFP: { n: '梦境画布的变色蝶', i: '🦋', text: '“美是你的本能。你随情绪而生，在色彩里隐匿又绽放，不为任何人停留。”' },
  ESTP: { n: '荒野赛道的猎豹', i: '🐆', text: '“当下即是全部。速度是你与世界博弈的筹码，你从不在意终点在哪。”' },
  ESFP: { n: '永恒派对的孔雀', i: '🦚', text: '“生命不该被虚度。你是一场永不落幕的感官盛宴，燃烧着最热烈的情绪。”' }
};

let THREE;
let canvas;
let scene, camera, renderer, crystal;
let scaleTarget = 1.0, rotSpeed = 0.003;

Page({
  data: {
    step: 0, // 0: init gate, 1: loading, 2: config, 3: result
    selectedMBTI: 'INTJ',
    selectedGroup: 'analyst',
    selectedVibe: 'FLOW',
    loadProgress: 0,
    loadMessage: 'Mapping Neural Paths...',
    resId: '#----',
    resData: {}
  },

  onReady() {
    // Note: Due to limitations of WebGL cross-platform, we need caching
    wx.createSelectorQuery().select('#webgl').node().exec((res) => {
      const node = res[0].node
      this._initWebGL(node)
    })
  },

  onUnload() {
    if (renderer) {
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement = null
      renderer = null
    }
    THREE = null;
  },

  _initWebGL(node) {
    canvas = node;
    THREE = createScopedThreejs(canvas);

    // Set up renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // Handle retina
    const info = wx.getSystemInfoSync();
    renderer.setPixelRatio(Math.min(info.pixelRatio, 2));
    renderer.setSize(canvas.width, canvas.height);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, canvas.width / canvas.height, 0.1, 1000);
    camera.position.z = 5;

    const geo = new THREE.IcosahedronGeometry(1.8, 1);
    const mat = new THREE.MeshPhongMaterial({
      color: 0x6366f1,
      wireframe: true,
      transparent: true,
      opacity: 0.2
    });
    crystal = new THREE.Mesh(geo, mat);
    scene.add(crystal);
    scene.add(new THREE.PointLight(0x818cf8, 2, 50));
    scene.add(new THREE.AmbientLight(0x404040));

    // Render loop
    const render = () => {
      if (!renderer) return;
      canvas.requestAnimationFrame(render);
      crystal.rotation.y += rotSpeed;
      crystal.rotation.z += rotSpeed * 0.3;
      const currentS = crystal.scale.x;
      const lerpS = currentS + (scaleTarget - currentS) * 0.1;
      crystal.scale.setScalar(lerpS + Math.sin(Date.now() * 0.002) * 0.05);
      renderer.render(scene, camera);
    }
    render();
  },

  touchStart(e) { },
  touchMove(e) { },
  touchEnd(e) { },

  enterLab() {
    // Tone.js unsupported, skipping audio setup
    this.setData({ step: 2 });
  },

  setMBTI(e) {
    const v = e.currentTarget.dataset.m;
    const g = e.currentTarget.dataset.g;
    this.setData({ selectedMBTI: v, selectedGroup: g });

    const colors = { analyst: 0xa855f7, diplomat: 0x10b981, sentinel: 0x3b82f6, explorer: 0xf59e0b };
    if (crystal) {
      crystal.material.color.setHex(colors[g]);
    }
  },

  setVibe(e) {
    const v = e.currentTarget.dataset.v;
    this.setData({ selectedVibe: v });

    if (!crystal) return;
    if (v === 'GLITCH') { crystal.material.wireframe = true; scaleTarget = 0.8; rotSpeed = 0.03; }
    else if (v === 'SPARK') { crystal.material.wireframe = false; scaleTarget = 1.4; rotSpeed = 0.01; }
    else if (v === 'VOID') { crystal.material.opacity = 0.05; scaleTarget = 0.5; rotSpeed = 0.001; }
    else { crystal.material.wireframe = true; scaleTarget = 1.1; rotSpeed = 0.003; crystal.material.opacity = 0.2; }
  },

  startSynthesis() {
    this.setData({ step: 1, loadProgress: 0, loadMessage: "Extracting Neural DNA..." });
    let p = 0;

    const interval = setInterval(() => {
      p += 2;
      this.setData({ loadProgress: p });
      if (p === 30) this.setData({ loadMessage: `Aligning ${this.data.selectedMBTI} Matrix...` });
      if (p === 60) this.setData({ loadMessage: `Injecting ${this.data.selectedVibe} Energy...` });

      if (p >= 100) {
        clearInterval(interval);

        const finalId = Math.floor(Math.random() * 8999) + 1000;
        this.setData({
          step: 3,
          resId: '#' + finalId,
          resData: personalityDB[this.data.selectedMBTI]
        });
      }
    }, 30);
  },

  restart() {
    this.setData({ step: 2 });
  },

  saveSpecimen() {
    wx.showToast({ title: '保存成功 (Mock)', icon: 'success' });
  }
})
