import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import {
  DEFAULT_CHARACTER,
  EYE_COLORS,
  HAIR_COLORS,
  OPTIONS,
  OUTFIT_COLORS,
  SKIN_TONES,
  buildCharacter,
  disposeCharacter,
  normalizeCharacter,
  poseCharacter,
  randomCharacter,
} from "./character.js";

// The "Create your character" step on the start card: option controls on one side and a live
// turntable preview of the candidate on the other. Choices are saved per name in localStorage.

const STORE_PREFIX = "hotseat_character:";
const LAST_KEY = "hotseat_character_last";

const TABS = [
  {
    id: "face",
    label: "Face",
    rows: [
      { key: "skin", label: "Skin tone", swatches: SKIN_TONES },
      { key: "face", label: "Face shape", choices: OPTIONS.face },
      { key: "eyes", label: "Eye color", swatches: EYE_COLORS },
      { key: "glasses", label: "Glasses", choices: OPTIONS.glasses },
      { key: "facialHair", label: "Facial hair", choices: OPTIONS.facialHair },
    ],
  },
  {
    id: "hair",
    label: "Hair",
    rows: [
      { key: "hair", label: "Style", choices: OPTIONS.hair },
      { key: "hairColor", label: "Color", swatches: HAIR_COLORS },
    ],
  },
  {
    id: "outfit",
    label: "Outfit",
    rows: [
      { key: "outfit", label: "Outfit", choices: OPTIONS.outfit },
      { key: "outfitColor", label: "Color", swatches: OUTFIT_COLORS, picker: true },
    ],
  },
  {
    id: "extras",
    label: "Extras",
    rows: [{ key: "accessories", label: "Accessories", toggles: OPTIONS.accessories }],
  },
];

const hex = (n) => `#${Number(n).toString(16).padStart(6, "0")}`;

function storeKey(name) {
  return STORE_PREFIX + (name || "").trim().toLowerCase();
}

function load(name) {
  try {
    const raw = localStorage.getItem(storeKey(name)) || localStorage.getItem(LAST_KEY);
    return raw ? normalizeCharacter(JSON.parse(raw)) : { ...DEFAULT_CHARACTER };
  } catch {
    return { ...DEFAULT_CHARACTER };
  }
}

function save(name, character) {
  try {
    const raw = JSON.stringify(character);
    localStorage.setItem(LAST_KEY, raw);
    if ((name || "").trim()) {
      localStorage.setItem(storeKey(name), raw);
    }
  } catch {
    // private windows can refuse storage; the character still works for this visit
  }
}

export function initCreator() {
  const root = document.getElementById("creator");
  const nameInput = document.getElementById("name");
  if (!root) {
    return { character: () => ({ ...DEFAULT_CHARACTER }) };
  }

  let character = load(nameInput ? nameInput.value : "");
  let activeTab = "face";

  const tabsEl = root.querySelector(".ctabs");
  const panelEl = root.querySelector(".cpanel");
  const preview = createPreview(root.querySelector(".cstage canvas"));
  preview.show(character);

  // redraw=false keeps the panel's elements in place, for the color input while its picker is open.
  function update(change, redraw = true) {
    character = normalizeCharacter({ ...character, ...change });
    save(nameInput ? nameInput.value : "", character);
    preview.show(character);
    if (redraw) {
      renderPanel();
    }
  }

  function renderTabs() {
    tabsEl.innerHTML = TABS.map(
      (t) =>
        `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === activeTab}" class="${t.id === activeTab ? "on" : ""}">${t.label}</button>`,
    ).join("");
  }

  function renderRow(row) {
    const value = character[row.key];
    let body = "";
    if (row.swatches) {
      body = row.swatches
        .map(
          (c) =>
            `<button type="button" class="swatch${c === value ? " on" : ""}" style="--c:${hex(c)}" data-key="${row.key}" data-value="${c}" aria-label="${hex(c)}" aria-pressed="${c === value}"></button>`,
        )
        .join("");
      if (row.picker) {
        // any colour beyond the presets; the input itself is the swatch
        const custom = !row.swatches.includes(value);
        body += `<label class="swatch picker${custom ? " on" : ""}" style="--c:${hex(value)}" title="Pick any color"><input type="color" data-key="${row.key}" value="${hex(value)}" /></label>`;
      }
    } else if (row.choices) {
      body = row.choices
        .map(
          (o) =>
            `<button type="button" class="chipbtn${o.id === value ? " on" : ""}" data-key="${row.key}" data-value="${o.id}" aria-pressed="${o.id === value}">${o.label}</button>`,
        )
        .join("");
    } else if (row.toggles) {
      body = row.toggles
        .map((o) => {
          const on = value.includes(o.id);
          return `<button type="button" class="chipbtn${on ? " on" : ""}" data-toggle="${row.key}" data-value="${o.id}" aria-pressed="${on}">${on ? "✓ " : ""}${o.label}</button>`;
        })
        .join("");
    }
    return `<div class="crow"><div class="crowlabel">${row.label}</div><div class="crowbody">${body}</div></div>`;
  }

  function renderPanel() {
    const tab = TABS.find((t) => t.id === activeTab);
    panelEl.innerHTML = tab.rows.map(renderRow).join("");
  }

  tabsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) {
      return;
    }
    activeTab = b.dataset.tab;
    // face details are small, so the preview leans in for them
    preview.focus(activeTab === "face" || activeTab === "hair" ? "head" : "body");
    renderTabs();
    renderPanel();
  });

  panelEl.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) {
      return;
    }
    if (b.dataset.toggle) {
      const list = character[b.dataset.toggle];
      const id = b.dataset.value;
      update({ [b.dataset.toggle]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
      return;
    }
    const key = b.dataset.key;
    const isColor = TABS.some((t) => t.rows.some((r) => r.key === key && r.swatches));
    update({ [key]: isColor ? Number(b.dataset.value) : b.dataset.value });
  });

  // Redrawing on every input would replace the color input under the open picker, and the
  // picker's later moves would land on a detached element. So input only recolors the swatch,
  // and the panel redraws once the picker closes (change).
  panelEl.addEventListener("input", (e) => {
    const input = e.target.closest('input[type="color"]');
    if (input) {
      update({ [input.dataset.key]: parseInt(input.value.slice(1), 16) }, false);
      input.closest("label").style.setProperty("--c", input.value);
    }
  });
  panelEl.addEventListener("change", (e) => {
    if (e.target.closest('input[type="color"]')) {
      renderPanel();
    }
  });

  root.querySelector("#charRandom").addEventListener("click", () => {
    update(randomCharacter());
    preview.spin();
  });
  root.querySelector("#charReset").addEventListener("click", () => {
    update({ ...DEFAULT_CHARACTER });
  });

  // a returning name brings back that person's character
  if (nameInput) {
    nameInput.addEventListener("change", () => {
      const saved = localStorage.getItem(storeKey(nameInput.value));
      if (saved) {
        character = load(nameInput.value);
        preview.show(character);
        renderPanel();
      } else {
        save(nameInput.value, character);
      }
    });
  }

  renderTabs();
  renderPanel();
  preview.focus("head");

  return {
    character: () => ({ ...character, accessories: [...character.accessories] }),
  };
}

// ---------- the turntable preview ----------

function createPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;

  // the same warm key and cool rim as the interview room, so the preview matches what you will see
  scene.add(new THREE.HemisphereLight(0xffe7c8, 0x1a1410, 0.6));
  const key = new THREE.DirectionalLight(0xffd8b0, 2.4);
  key.position.set(1.6, 4, 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -1.5;
  key.shadow.camera.right = 1.5;
  key.shadow.camera.top = 3;
  key.shadow.camera.bottom = -0.5;
  key.shadow.radius = 4;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb4ff, 1.6);
  rim.position.set(-2.5, 3, -3);
  scene.add(rim);

  // a round platform the character turns on
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(0.75, 0.8, 0.08, 64),
    new THREE.MeshStandardMaterial({ color: 0x2a231e, roughness: 0.6 }),
  );
  plate.position.y = -0.04;
  plate.receiveShadow = true;
  scene.add(plate);
  const edge = new THREE.Mesh(
    new THREE.TorusGeometry(0.78, 0.008, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0xe8a33d, toneMapped: false }),
  );
  edge.rotation.x = Math.PI / 2;
  scene.add(edge);

  const turntable = new THREE.Group();
  scene.add(turntable);

  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 40);
  // two framings: the whole body, and a close look at the face
  const framings = {
    body: { pos: new THREE.Vector3(0, 1.35, 6.4), look: new THREE.Vector3(0, 1.15, 0) },
    head: { pos: new THREE.Vector3(0, 1.95, 3.2), look: new THREE.Vector3(0, 1.75, 0) },
  };
  let framing = framings.head;
  const camPos = framing.pos.clone();
  const camLook = framing.look.clone();

  let current = null;
  let angle = 0.5;
  let velocity = 0;
  let dragging = false;
  let lastX = 0;
  let idleSince = 0;
  let spinBoost = 0;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("grabbing");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) {
      return;
    }
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    angle += dx * 0.012;
    velocity = dx * 0.012;
  });
  const release = () => {
    dragging = false;
    idleSince = performance.now();
    canvas.classList.remove("grabbing");
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  // double click flips between the face and the full body
  canvas.addEventListener("dblclick", () => {
    framing = framing === framings.head ? framings.body : framings.head;
  });

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) {
      return;
    }
    if (canvas.width !== Math.round(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const timer = new THREE.Timer();
  function frame(ts) {
    requestAnimationFrame(frame);
    // nothing to draw while the start card is hidden
    if (!canvas.offsetParent) {
      return;
    }
    timer.update(ts);
    const dt = Math.min(timer.getDelta(), 0.05);
    const t = timer.getElapsed();
    resize();

    if (!dragging) {
      // momentum after a drag, then a slow idle turn
      velocity *= 0.92;
      angle += velocity;
      if (performance.now() - idleSince > 1800) {
        angle += dt * 0.35;
      }
      if (spinBoost > 0) {
        angle += dt * spinBoost;
        spinBoost = Math.max(0, spinBoost - dt * 14);
      }
    }
    turntable.rotation.y = angle;

    camPos.lerp(framing.pos, 1 - Math.exp(-dt * 5));
    camLook.lerp(framing.look, 1 - Math.exp(-dt * 5));
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    if (current) {
      poseCharacter(current, { t, dt });
    }
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  return {
    show(config) {
      if (current) {
        turntable.remove(current.root);
        disposeCharacter(current);
      }
      current = buildCharacter(config);
      turntable.add(current.root);
    },
    focus(which) {
      framing = framings[which] || framings.body;
    },
    spin() {
      spinBoost = 7;
    },
  };
}
