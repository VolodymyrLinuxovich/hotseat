import * as THREE from "three";

// The night city outside the window: a dusk sky, a moon, and three layers of buildings at real
// depths behind the wall, so they slide past each other when the camera moves.

// A small seeded random, so the skyline is the same on every visit instead of reshuffling.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sky as a shader on a far plane: the colour depends on how high above the horizon a point is,
// seen from the middle of the room, so the band of dusk sits low in the window from any seat.
function buildSky(scene) {
  const material = new THREE.ShaderMaterial({
    depthWrite: false,
    fog: false,
    uniforms: {
      eye: { value: new THREE.Vector3(0, 1.8, 6) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: `
      uniform vec3 eye;
      varying vec3 vWorld;
      void main() {
        vec3 d = normalize(vWorld - eye);
        float h = clamp(d.y * 2.5, 0.0, 1.0);
        vec3 horizon = vec3(0.95, 0.56, 0.34);
        vec3 dusk = vec3(0.55, 0.3, 0.47);
        vec3 night = vec3(0.12, 0.12, 0.3);
        vec3 top = vec3(0.03, 0.04, 0.12);
        vec3 c = mix(horizon, dusk, smoothstep(0.04, 0.28, h));
        c = mix(c, night, smoothstep(0.26, 0.6, h));
        c = mix(c, top, smoothstep(0.6, 1.0, h));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(240, 90), material);
  sky.position.set(0, 30, -70);
  sky.renderOrder = -10;
  scene.add(sky);

  // a few faint stars high up, where the sky is darkest
  const rand = seeded(7);
  const stars = [];
  for (let i = 0; i < 140; i++) {
    stars.push((rand() - 0.5) * 160, 16 + rand() * 40, -69);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.Float32BufferAttribute(stars, 3));
  const starPoints = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({
      color: 0xdfe6ff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.55,
      fog: false,
      depthWrite: false,
    }),
  );
  starPoints.renderOrder = -9;
  scene.add(starPoints);

  // the moon, with a soft halo, off to the left so it does not sit behind a head
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 48),
    new THREE.MeshBasicMaterial({ color: 0xfff3dc, fog: false, toneMapped: false }),
  );
  moon.position.set(-11.5, 18.5, -68.5);
  moon.renderOrder = -8;
  scene.add(moon);
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.MeshBasicMaterial({
      map: glowTexture("255,236,205"),
      transparent: true,
      opacity: 0.5,
      fog: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  halo.position.set(-11.5, 18.5, -68.8);
  halo.renderOrder = -9;
  scene.add(halo);
}

function glowTexture(rgb) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, `rgba(${rgb},0.9)`);
  grad.addColorStop(0.25, `rgba(${rgb},0.35)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Draws one layer of skyline onto a transparent canvas. Buildings are rectangles with an
// occasional setback and rooftop detail; windows sit in a proper grid per building, and whole
// floors tend to be lit or dark together, the way offices and flats look at night.
function skylineTexture(o) {
  const rand = seeded(o.seed);
  const c = document.createElement("canvas");
  c.width = o.px;
  c.height = Math.round(o.px / o.aspect);
  const g = c.getContext("2d");
  const W = c.width;
  const H = c.height;

  let x = -rand() * 40;
  while (x < W) {
    const bw = o.minW + rand() * (o.maxW - o.minW);
    const bh = H * (o.minH + rand() * (o.maxH - o.minH));
    const top = H - bh;
    const tone = o.body[Math.floor(rand() * o.body.length)];

    g.fillStyle = tone;
    g.fillRect(x, top, bw, bh);

    // a narrower upper tier on some of the taller towers
    let roofTop = top;
    if (rand() < 0.35 && bh > H * 0.5) {
      const inset = bw * (0.15 + rand() * 0.15);
      const extra = bh * (0.08 + rand() * 0.1);
      g.fillRect(x + inset, top - extra, bw - inset * 2, extra);
      roofTop = top - extra;
    }

    // rooftop detail: an antenna with a red light, or a water tank
    const roof = rand();
    if (roof < 0.25) {
      const ax = x + bw * (0.3 + rand() * 0.4);
      const ah = o.windowH * (3 + rand() * 4);
      g.fillRect(ax, roofTop - ah, Math.max(1, o.windowW * 0.25), ah);
      g.fillStyle = "rgba(255,70,60,0.95)";
      g.beginPath();
      g.arc(ax + 1, roofTop - ah, Math.max(1.5, o.windowW * 0.35), 0, Math.PI * 2);
      g.fill();
    } else if (roof < 0.4) {
      const tw = bw * 0.22;
      g.fillRect(x + bw * 0.6, roofTop - tw * 0.8, tw, tw * 0.8);
    }

    // window grid
    const gapX = o.windowW * (0.7 + rand() * 0.5);
    const gapY = o.windowH * 0.9;
    const margin = o.windowW * 1.2;
    const cols = Math.floor((bw - margin * 2 + gapX) / (o.windowW + gapX));
    const rows = Math.floor((bh - margin * 1.5) / (o.windowH + gapY));
    const gridW = cols * o.windowW + (cols - 1) * gapX;
    const startX = x + (bw - gridW) / 2;
    const warm = rand() < 0.75;
    for (let r = 0; r < rows; r++) {
      // each floor has its own chance of being lit
      const floorLit = rand() < 0.5 ? o.lit * 1.6 : o.lit * 0.35;
      const wy = top + margin + r * (o.windowH + gapY);
      for (let k = 0; k < cols; k++) {
        const wx = startX + k * (o.windowW + gapX);
        if (rand() < floorLit) {
          const b = 0.65 + rand() * 0.35;
          // most buildings glow warm with the odd cool screen; a few are the other way round
          const odd = rand() < (warm ? 0.15 : 0.3);
          const tint = warm === odd ? "190,215,255" : "255,214,150";
          g.fillStyle = `rgba(${tint},${(o.glow * b).toFixed(2)})`;
        } else {
          g.fillStyle = o.dark;
        }
        g.fillRect(wx, wy, o.windowW, o.windowH);
      }
    }

    x += bw + (rand() < 0.3 ? o.gap * rand() : 0);
  }

  // haze at the foot of the layer, so the bases melt into the city glow below the window
  const haze = g.createLinearGradient(0, H * 0.55, 0, H);
  haze.addColorStop(0, "rgba(0,0,0,0)");
  haze.addColorStop(1, o.haze);
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = haze;
  g.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function skylineLayer(scene, { z, width, height, bottom, ...o }) {
  const tex = skylineTexture({ ...o, aspect: width / height });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false, toneMapped: false }),
  );
  mesh.position.set(0, bottom + height / 2, z);
  scene.add(mesh);
  return mesh;
}

export function buildCity(scene) {
  buildSky(scene);

  // far: hazy towers tinted toward the dusk sky, with tiny dim windows
  skylineLayer(scene, {
    z: -48,
    width: 150,
    height: 30,
    bottom: -4,
    px: 2048,
    seed: 11,
    minW: 26,
    maxW: 70,
    minH: 0.4,
    maxH: 0.6,
    windowW: 3,
    windowH: 3,
    gap: 10,
    lit: 0.22,
    glow: 0.45,
    body: ["#3a2f4f", "#3f3354", "#352b4a"],
    dark: "rgba(20,18,36,0.6)",
    haze: "rgba(160,90,90,0.55)",
  });

  // middle: the main skyline
  skylineLayer(scene, {
    z: -26,
    width: 80,
    height: 16,
    bottom: -2,
    px: 2048,
    seed: 23,
    minW: 40,
    maxW: 110,
    minH: 0.45,
    maxH: 0.85,
    windowW: 4,
    windowH: 4,
    gap: 14,
    lit: 0.26,
    glow: 0.75,
    body: ["#13142a", "#17182e", "#111226"],
    dark: "rgba(10,11,22,0.85)",
    haze: "rgba(110,60,70,0.5)",
  });

  // near: a few big dark blocks close by, with large clear windows
  skylineLayer(scene, {
    z: -13,
    width: 40,
    height: 8,
    bottom: -1,
    px: 2048,
    seed: 41,
    minW: 120,
    maxW: 300,
    minH: 0.42,
    maxH: 0.78,
    windowW: 7,
    windowH: 8,
    gap: 40,
    lit: 0.24,
    glow: 0.9,
    body: ["#0a0b14", "#0c0d17", "#090a12"],
    dark: "rgba(22,24,40,0.95)",
    haze: "rgba(40,30,50,0.6)",
  });
}
