/* 食光菜谱 · 交互逻辑
 * 勾选食材 → 按主料匹配度给菜谱打分 → 按人数等比换算用量 → 展示分步教程
 */
(function () {
  'use strict';

  const D = window.RECIPE_DATA;
  const ING = D.INGREDIENTS;
  const RECIPES = D.RECIPES;
  const CATS = D.CATEGORIES;
  const MEAT_CATS = new Set(['meat']);

  const K = window.KITCHEN || { GEAR: [], PANTRY: [], SEASONING_MAP: {}, RECIPE_META: {} };
  const GEAR = K.GEAR;
  const PANTRY = K.PANTRY;
  const GEAR_BY_ID = new Map(GEAR.map((g) => [g.id, g]));
  const PANTRY_BY_ID = new Map(PANTRY.map((p) => [p.id, p]));
  const ALL_PANTRY = PANTRY.map((p) => p.id);

  const KEY = {
    fav: 'recipe-studio:favorites',
    theme: 'recipe-studio:theme',
    servings: 'recipe-studio:servings',
    gear: 'recipe-studio:gear',
    pantry: 'recipe-studio:pantry',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const readJSON = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 忽略隐私模式报错 */ }
  };

  const state = {
    // 食材每次重新勾选；厨具与常备调料长期保存
    selected: new Set(),
    gear: new Set(readJSON(KEY.gear, [])),
    pantry: new Set(readJSON(KEY.pantry, ALL_PANTRY)),
    health: new Set(),
    mood: null,
    servings: clampServings(readJSON(KEY.servings, 2)),
    query: '',
    cuisine: '全部',
    maxTime: 999,
    readyOnly: false,
    favOnly: false,
    favorites: new Set(readJSON(KEY.fav, [])),
    generated: false,
  };

  /* ---------- 导入菜谱（长期保存） ---------- */
  const IMPORT_KEY = 'recipe-studio:imported';
  const CUSTOM_ING_KEY = 'recipe-studio:custom-ingredients';

  const importedRecipes = readJSON(IMPORT_KEY, []);
  const customIngredients = readJSON(CUSTOM_ING_KEY, {});

  Object.entries(customIngredients).forEach(([id, meta]) => {
    ING[id] = meta;
  });
  importedRecipes.forEach((r) => {
    if (!RECIPES.some((x) => x.id === r.id)) RECIPES.push(r);
  });

  if (!CATS.some((c) => c.id === 'other')) {
    CATS.push({ id: 'other', name: '我的食材', emoji: '🥢' });
  }

  function clampServings(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return 2;
    return Math.min(12, Math.max(1, v));
  }

  /* ---------- 用量换算 ---------- */
  function fmtQty(v) {
    if (!Number.isFinite(v) || v <= 0) return '少许';
    if (v >= 100) return String(Math.round(v / 10) * 10);
    if (v >= 20) return String(Math.round(v));
    if (v >= 1) {
      const half = Math.round(v * 2) / 2;
      return Number.isInteger(half) ? String(half) : half.toFixed(1);
    }
    if (v >= 0.25) return String(Math.round(v * 4) / 4);
    return '少许';
  }

  const scaleOf = (recipe) => state.servings / (recipe.base || 2);
  const amountText = (item, recipe) => `${fmtQty(item.q * scaleOf(recipe))}${item.unit || ''}`;

  /* ---------- 匹配打分 ---------- */
  // 葱姜蒜辣椒香菜属于增香配料：没有也能做，不算“还差”
  const OPTIONAL_IDS = new Set(['scallion', 'ginger', 'garlic', 'chili', 'cilantro']);

  const META = K.RECIPE_META || {};
  const metaOf = (recipe) => META[recipe.id] || { gear: [], health: { oil: '中', salt: '中', gi: '中' } };

  function evaluate(recipe) {
    const req = [];
    const opt = [];
    for (const m of recipe.mains) {
      (OPTIONAL_IDS.has(m.id) ? opt : req).push(m);
    }
    const have = req.filter((m) => state.selected.has(m.id));
    const miss = req.filter((m) => !state.selected.has(m.id));

    const meta = metaOf(recipe);
    // 厨具：每个内层数组都是“任选其一”，没设置过厨具时不做过滤
    const missingGear = state.gear.size
      ? (meta.gear || []).filter((group) => !group.some((id) => state.gear.has(id)))
      : [];
    // 调料：从菜谱的 seasonings 自动推导
    const needPantry = Array.from(
      new Set((recipe.seasonings || []).map((s) => K.SEASONING_MAP[s.name]).filter(Boolean))
    );
    const missingPantry = needPantry.filter((id) => !state.pantry.has(id));

    return {
      recipe,
      req,
      opt,
      have,
      miss,
      rate: req.length ? have.length / req.length : 1,
      gear: meta.gear || [],
      health: meta.health || { oil: '中', salt: '中', gi: '中' },
      missingGear,
      missingPantry,
    };
  }

  function matchesFilters(recipe, result) {
    if (state.favOnly && !state.favorites.has(recipe.id)) return false;
    if (recipe.time > state.maxTime) return false;
    if (state.cuisine !== '全部' && recipe.cuisine !== state.cuisine) return false;
    if (state.readyOnly && result.miss.length > 0) return false;
    // 至少一种主料对得上、最多只差两样，且匹配度不低于 1/3
    if (!state.readyOnly && state.selected.size > 0) {
      if (result.have.length === 0) return false;
      if (result.miss.length > 2) return false;
      if (result.rate + 1e-9 < 1 / 3) return false;
    }
    return true;
  }

  function getResults() {
    const stats = {
      gear: 0,
      pantry: 0,
      health: 0,
      mood: 0,
      total: RECIPES.length,
      gearNames: new Set(),
      pantryNames: new Set(),
    };
    const list = [];
    const mood = state.mood ? MOODS.find((m) => m.id === state.mood) : null;

    for (const recipe of RECIPES) {
      const result = evaluate(recipe);
      if (result.missingGear.length) {
        stats.gear += 1;
        result.missingGear.forEach((group) =>
          group.forEach((id) => stats.gearNames.add((GEAR_BY_ID.get(id) || { name: id }).name))
        );
        continue;
      }
      if (result.missingPantry.length) {
        stats.pantry += 1;
        result.missingPantry.forEach((id) => stats.pantryNames.add((PANTRY_BY_ID.get(id) || { name: id }).name));
        continue;
      }
      if (state.health.size && !Array.from(state.health).every((dim) => result.health[dim] === '低')) {
        stats.health += 1;
        continue;
      }
      if (mood && !mood.test(recipe)) {
        stats.mood += 1;
        continue;
      }
      if (!matchesFilters(recipe, result)) continue;
      list.push(result);
    }

    list.sort((a, b) => {
      if (b.rate !== a.rate) return b.rate - a.rate;
      if (a.miss.length !== b.miss.length) return a.miss.length - b.miss.length;
      return a.recipe.time - b.recipe.time;
    });

    return { list, stats };
  }

  /* ---------- 食材选择区 ---------- */
  const usage = new Map();
  const byCat = new Map();

  function rebuildIndexes() {
    usage.clear();
    for (const r of RECIPES) {
      for (const m of r.mains) usage.set(m.id, (usage.get(m.id) || 0) + 1);
    }
    byCat.clear();
    CATS.forEach((c) => byCat.set(c.id, []));
    for (const [id, meta] of Object.entries(ING)) {
      const bucket = byCat.get(meta.cat);
      if (bucket) bucket.push({ id, ...meta, count: usage.get(id) || 0 });
    }
    for (const list of byCat.values()) {
      list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
    }
  }
  rebuildIndexes();

  function renderGroups() {
    const q = state.query.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let visible = 0;

    for (const cat of CATS) {
      const items = (byCat.get(cat.id) || []).filter((it) =>
        !q || it.name.toLowerCase().includes(q) || it.id.includes(q)
      );
      if (!items.length) continue;
      visible += 1;

      const details = document.createElement('details');
      details.className = 'group';
      details.dataset.cat = cat.id;
      details.open = true;
      if (items.some((it) => state.selected.has(it.id))) details.dataset.has = '1';

      const picked = items.filter((it) => state.selected.has(it.id)).length;
      details.innerHTML = `
        <summary>${cat.emoji} ${cat.name} <span class="g-count">${picked}/${items.length}</span></summary>
        <div class="chips">
          ${items
            .map(
              (it) => `
            <label class="chip" title="${it.name} · ${it.count} 道菜用到">
              <input type="checkbox" value="${it.id}" ${state.selected.has(it.id) ? 'checked' : ''} />
              <span class="chip-face"><span class="tick">✓</span>${it.emoji} ${it.name}</span>
            </label>`
            )
            .join('')}
        </div>`;
      frag.appendChild(details);
    }

    const wrap = $('#groups');
    wrap.innerHTML = '';
    if (!visible) {
      wrap.innerHTML = '<p class="hint" style="margin-top:14px">没有找到这个食材，换个关键词试试。</p>';
    } else {
      wrap.appendChild(frag);
    }
    updateBadges();
  }

  function updateGroupCounts() {
    $$('#groups .group').forEach((group) => {
      const boxes = $$('input[type="checkbox"]', group);
      const picked = boxes.filter((b) => b.checked).length;
      const badge = $('.g-count', group);
      if (badge) badge.textContent = `${picked}/${boxes.length}`;
      group.dataset.has = picked ? '1' : '';
    });
    updateBadges();
  }

  function updateBadges() {
    const n = state.selected.size;
    $('#pickedBadge').textContent = `已选 ${n}`;
    $('#mbPicked').textContent = n;
    $('#mbServings').textContent = state.servings;
    const count = $('#generateCount');
    if (n) {
      count.textContent = n;
      count.classList.add('show');
    } else {
      count.classList.remove('show');
    }
    $('#servingsHint').textContent = `用量会按 ${state.servings} 人份换算`;
    updateGearBadge();
    updatePantryBadge();
  }

  /* ---------- 长期设置：厨具 / 常备调料 ---------- */
  function chipMarkup(list, selected) {
    return list
      .map(
        (item) => `
      <label class="chip soft" title="${item.name}">
        <input type="checkbox" value="${item.id}" ${selected.has(item.id) ? 'checked' : ''} />
        <span class="chip-face"><span class="tick">✓</span>${item.emoji || ''} ${item.name}</span>
      </label>`
      )
      .join('');
  }

  function renderGear() {
    $('#gearChips').innerHTML = chipMarkup(GEAR, state.gear);
    updateGearBadge();
  }

  function renderPantry() {
    $('#pantryChips').innerHTML = chipMarkup(PANTRY, state.pantry);
    updatePantryBadge();
  }

  function updateGearBadge() {
    const badge = $('#gearBadge');
    if (!badge) return;
    badge.textContent = state.gear.size ? `已选 ${state.gear.size}` : '未设置';
    badge.classList.toggle('is-muted', !state.gear.size);
  }

  function updatePantryBadge() {
    const badge = $('#pantryBadge');
    if (!badge) return;
    badge.textContent = state.pantry.size === ALL_PANTRY.length ? '全有' : `${state.pantry.size}/${ALL_PANTRY.length}`;
    badge.classList.toggle('is-muted', state.pantry.size === ALL_PANTRY.length);
  }

  function refreshResultsIfShown() {
    if (!state.generated) return;
    renderResults();
    if (!$('#combo').classList.contains('hidden')) renderCombo();
  }

  /* ---------- 结果区 ---------- */
  const cuisineOptions = () => ['全部', ...Array.from(new Set(RECIPES.map((r) => r.cuisine)))];

  /* ---------- 心情（当前状态） ---------- */
  const RED_MEAT = new Set(['beef', 'beef-mince', 'pork-belly', 'pork-loin', 'pork-mince', 'pork-rib', 'lamb']);

  const MOODS = [
    {
      id: 'cold',
      label: '有点冷',
      emoji: '🥶',
      test: (r) => isSoup(r) || r.tags.includes('一锅出') || /炖|烧|煲|汤|咖喱|焖|火锅/.test(r.name),
    },
    {
      id: 'hot',
      label: '有点热',
      emoji: '🥵',
      test: (r) => r.cuisine === '凉菜' || r.tags.includes('清淡') || /凉拌|蒸|白灼|沙拉|冷面/.test(r.name),
    },
    {
      id: 'blood',
      label: '想喝血',
      emoji: '🩸',
      test: (r) => r.mains.some((m) => RED_MEAT.has(m.id)),
    },
    {
      id: 'meat',
      label: '想吃肉',
      emoji: '🍖',
      test: (r) => r.mains.some((m) => ING[m.id] && ING[m.id].cat === 'meat'),
    },
    {
      id: 'veg',
      label: '想吃青菜',
      emoji: '🥬',
      test: (r) =>
        r.mains.length > 0 && r.mains.every((m) => ['veg', 'bean'].includes((ING[m.id] || {}).cat)),
    },
    {
      id: 'soup',
      label: '想喝汤',
      emoji: '🍲',
      test: (r) => isSoup(r),
    },
    {
      id: 'spicy',
      label: '想吃辣',
      emoji: '🌶️',
      test: (r) =>
        r.tags.some((t) => /辣/.test(t)) || (r.seasonings || []).some((s) => /辣椒|豆瓣酱|花椒|辣酱/.test(s.name)),
    },
  ];

  function renderMoodChips() {
    $('#moodChips').innerHTML = MOODS.map(
      (m) =>
        `<button type="button" class="pill mood-pill ${state.mood === m.id ? 'is-on' : ''}" data-mood="${m.id}" aria-pressed="${
          state.mood === m.id
        }">${m.emoji} ${m.label}</button>`
    ).join('');
  }

  function renderCuisineChips() {
    $('#cuisineChips').innerHTML = cuisineOptions()
      .map(
        (c) =>
          `<button type="button" class="pill ${c === state.cuisine ? 'is-on' : ''}" data-cuisine="${c}">${c}</button>`
      )
      .join('');
  }

  function ringClass(rate) {
    return rate >= 1 ? 'ring is-full' : 'ring';
  }

  function cardHTML(result) {
    const r = result.recipe;
    const pct = Math.round(result.rate * 100);
    const fav = state.favorites.has(r.id);
    const ingChips = r.mains
      .map((m) => {
        const meta = ING[m.id];
        const ok = state.selected.has(m.id);
        const optional = OPTIONAL_IDS.has(m.id);
        const kind = ok ? 'have' : optional ? 'opt' : 'miss';
        const mark = ok ? '✓' : optional ? '可缺' : '需';
        return `<span class="mini ${kind}">${mark} ${meta ? meta.name : m.id} ${amountText(m, r)}</span>`;
      })
      .join('');

    const h = result.health;
    const healthChips = [
      h.oil === '低' ? '<span class="hchip is-good">低油</span>' : h.oil === '高' ? '<span class="hchip is-high">高油</span>' : '',
      h.salt === '低' ? '<span class="hchip is-good">低盐</span>' : h.salt === '高' ? '<span class="hchip is-high">高盐</span>' : '',
      h.gi === '低' ? '<span class="hchip is-good">低 GI</span>' : h.gi === '高' ? '<span class="hchip is-high">高 GI</span>' : '',
    ]
      .filter(Boolean)
      .join('');

    return `
      <article class="card" data-id="${r.id}">
        <div class="card-top">
          <span class="card-emoji">${r.emoji}</span>
          ${
            state.selected.size
              ? `<div class="${ringClass(result.rate)}" style="--p:${pct}" title="主料匹配度 ${pct}%"><b>${pct}%</b></div>`
              : ''
          }
        </div>
        <h3>${r.name}</h3>
        <p class="desc">${r.desc}</p>
        <div class="metas">
          <span class="meta">⏱ ${r.time} 分钟</span>
          <span class="meta">🔥 ${r.difficulty}</span>
          <span class="meta">👥 ${state.servings} 人份</span>
          ${result.miss.length ? `<span class="meta warn">还差 ${result.miss.length} 样主料</span>` : '<span class="meta warn" style="background:var(--green-soft);color:var(--green)">食材齐全</span>'}
        </div>
        ${healthChips ? `<div class="health-line">${healthChips}</div>` : ''}
        <div class="ing-line">${ingChips}</div>
        <div class="card-foot">
          <button type="button" class="link-btn" data-open="${r.id}">查看教程 →</button>
          <button type="button" class="fav-btn ${fav ? 'is-on' : ''}" data-fav="${r.id}" aria-label="收藏 ${r.name}">${fav ? '♥' : '♡'}</button>
        </div>
      </article>`;
  }

  function exclusionNote(stats) {
    const parts = [];
    if (stats.gear) {
      const names = Array.from(stats.gearNames).slice(0, 3).join('、');
      parts.push(`${stats.gear} 道缺厨具${names ? `（${names}）` : ''}`);
    }
    if (stats.pantry) {
      const names = Array.from(stats.pantryNames).slice(0, 3).join('、');
      parts.push(`${stats.pantry} 道缺调料${names ? `（${names}）` : ''}`);
    }
    if (stats.health) parts.push(`${stats.health} 道不够清淡`);
    return parts.length ? `已排除 ${parts.join('；')}。` : '';
  }

  function renderResults() {
    const { list: results, stats } = getResults();
    const cards = $('#cards');
    const empty = $('#empty');
    const summary = $('#summary');
    const title = $('#resultTitle');

    if (!state.generated) {
      cards.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');

    if (!results.length) {
      cards.innerHTML = '';
      if (state.favOnly && !state.favorites.size) {
        title.textContent = '还没有收藏';
        summary.textContent = '在菜谱卡片右下角点一下 ♡ 就能收藏，下次直接从这里找。';
      } else {
        title.textContent = '没有匹配的菜谱';
        const why = exclusionNote(stats);
        summary.textContent = why
          ? `${why}检查一下第 3、4 步勾掉的厨具 / 调料，或者放宽食材与时间筛选。`
          : state.readyOnly
            ? '这些食材目前凑不齐任何一道菜的完整主料，关掉「只看食材齐全的」会看到差一两样的做法。'
            : '试试多勾几样食材，或放宽时间 / 菜系筛选。';
      }
      return;
    }

    const ready = results.filter((r) => r.rate >= 1).length;
    const near = results.length - ready;
    const moodNow = state.mood ? MOODS.find((m) => m.id === state.mood) : null;
    const moodText = moodNow ? `${moodNow.emoji} ${moodNow.label}` : '';

    title.textContent = state.selected.size
      ? `可以做这 ${results.length} 道`
      : moodNow
        ? `${moodText} · ${results.length} 道`
        : `全部 ${results.length} 道菜谱`;

    let base;
    if (state.selected.size) {
      base = `勾选的 ${state.selected.size} 种食材，${ready} 道主料齐全${near ? `，另有 ${near} 道只差一两样` : ''}；用量已按 ${state.servings} 人份换算。`;
    } else if (moodNow) {
      base = `${moodText}的时候，这 ${results.length} 道比较对味；用量按 ${state.servings} 人份换算。`;
    } else {
      base = `${RECIPES.length} 道家常菜按用时排序，勾选食材后会按「能做的程度」重新排序。`;
    }

    if (moodNow && state.selected.size) base += ` 心情：${moodText}。`;
    summary.textContent = base + exclusionNote(stats);

    cards.innerHTML = results.map(cardHTML).join('');
  }

  /* ---------- 一键配一桌 ---------- */
  function isMeat(recipe) {
    return recipe.mains.some((m) => MEAT_CATS.has(ING[m.id] && ING[m.id].cat));
  }
  function isSoup(recipe) {
    return recipe.tags.includes('汤水') || recipe.cuisine === '汤羹';
  }

  function buildCombo() {
    const { list: results } = getResults();
    if (results.length < 2) return null;

    const shared = (a, b) => {
      const ids = new Set(a.mains.map((m) => m.id));
      return b.mains.filter((m) => ids.has(m.id)).length;
    };

    const picks = [];
    const take = (pred) => {
      const found = results.find((r) => pred(r.recipe) && picks.every((p) => shared(p.recipe, r.recipe) === 0));
      if (found) picks.push(found);
      return found;
    };

    take((r) => isMeat(r) && !isSoup(r) && r.cuisine !== '甜品' && !r.tags.includes('甜品'));
    take((r) => !isMeat(r) && !isSoup(r) && r.cuisine !== '甜品' && !r.tags.includes('甜品'));
    take((r) => isSoup(r));
    if (picks.length < 3) take((r) => r.cuisine === '主食' || r.tags.includes('一锅出'));

    if (picks.length < 2) return null;

    const missing = new Map();
    let time = 0;
    for (const item of picks) {
      time = Math.max(time, item.recipe.time);
      for (const m of item.miss) {
        if (!state.selected.has(m.id)) missing.set(m.id, ING[m.id] ? ING[m.id].name : m.id);
      }
    }
    return { chosen: picks, time, missing: Array.from(missing.values()) };
  }

  function roleOf(result) {
    const r = result.recipe;
    if (isMeat(r) && !isSoup(r)) return '荤菜';
    if (isSoup(r)) return '汤';
    if (r.cuisine === '主食' || r.tags.includes('一锅出')) return '主食';
    return '素菜';
  }

  function renderCombo() {
    const box = $('#combo');
    const combo = buildCombo();
    if (!combo) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="combo-head">
        <h3>🍽 今晚这样配一桌</h3>
        <span class="combo-meta">${combo.chosen.length} 道菜 · 约 ${combo.time} 分钟 · ${state.servings} 人份${
          combo.missing.length ? ` · 还需 ${combo.missing.length} 样` : ' · 食材齐全'
        }</span>
      </div>
      <div class="combo-list">
        ${combo.chosen
          .map(
            (item) => `
          <button type="button" class="combo-item" data-open="${item.recipe.id}">
            <span class="ci-emoji">${item.recipe.emoji}</span>
            <span>
              <span class="ci-role">${roleOf(item)}</span><br />
              <span class="ci-name">${item.recipe.name}</span>
            </span>
          </button>`
          )
          .join('')}
      </div>
      ${combo.missing.length ? `<p class="hint" style="margin-top:10px">还差：${combo.missing.join('、')}</p>` : ''}
    `;
  }

  /* ---------- 菜谱详情 ---------- */
  let lastFocus = null;

  function openRecipe(id) {
    const recipe = RECIPES.find((r) => r.id === id);
    if (!recipe) return;
    const result = evaluate(recipe);
    const factor = scaleOf(recipe);
    const fav = state.favorites.has(recipe.id);

    const mains = recipe.mains
      .map((m) => {
        const meta = ING[m.id];
        const missing = !state.selected.has(m.id);
        const optional = OPTIONAL_IDS.has(m.id);
        const flag = missing ? (optional ? '<span class="flag opt">可缺</span>' : '<span class="flag">待补</span>') : '';
        return `<div class="ing-row ${missing ? 'miss' : ''}">
          <span class="name">${meta ? meta.emoji + ' ' + meta.name : m.id}${flag}</span>
          <span class="qty">${amountText(m, recipe)}</span>
        </div>`;
      })
      .join('');

    const seasonings = recipe.seasonings
      .map(
        (s) => `<div class="ing-row">
          <span class="name">${s.name}</span>
          <span class="qty">${fmtQty(s.q * factor)}${s.unit}</span>
        </div>`
      )
      .join('');

    const steps = recipe.steps
      .map((text) => `<div class="step"><div class="step-no"></div><p>${text}</p></div>`)
      .join('');

    const factorText =
      factor === 1
        ? `已按 ${state.servings} 人份 · 即原方份量`
        : `已按 ${state.servings} 人份换算 · 原方 ${recipe.base || 2} 人份 · ×${Number(factor.toFixed(2))}`;
    const statusText = result.miss.length
      ? `还差：${result.miss.map((m) => ING[m.id].name).join('、')}`
      : '✓ 主料齐全，可以直接做';

    const gearTags = result.gear.length
      ? result.gear
          .map((group) => {
            const ok = !state.gear.size || group.some((id) => state.gear.has(id));
            const names = group.map((id) => (GEAR_BY_ID.get(id) || { name: id }).name).join(' / ');
            return `<span class="mini ${ok ? 'have' : 'miss'}">${ok ? '✓' : '缺'} ${names}</span>`;
          })
          .join('')
      : '<span class="mini opt">不需要厨具</span>';

    const h = result.health;
    const healthTags = ['oil', 'salt', 'gi']
      .map((dim) => {
        const label = { oil: '用油', salt: '盐分', gi: 'GI' }[dim];
        const level = h[dim];
        const cls = level === '低' ? 'is-good' : level === '高' ? 'is-high' : '';
        return `<span class="hchip ${cls}">${label} ${level}</span>`;
      })
      .join('');

    $('#sheet').innerHTML = `
      <div class="sheet-head">
        <div class="card-emoji">${recipe.emoji}</div>
        <div>
          <h2 id="modalTitle">${recipe.name}</h2>
          <p class="sub">${recipe.cuisine} · ${recipe.time} 分钟 · ${recipe.difficulty} · ${state.servings} 人份${
            recipe.custom ? ' · 我导入的' : ''
          }</p>
        </div>
        <button type="button" class="sheet-close" data-close aria-label="关闭">✕</button>
      </div>
      <div class="sheet-body">
        <div class="req-box">
          <div class="req-row"><span class="req-label">需要厨具</span><span class="req-val">${gearTags}</span></div>
          <div class="req-row"><span class="req-label">口味标签</span><span class="req-val health-line">${healthTags}</span></div>
        </div>
        <div>
          <div class="block-title">用料清单</div>
          <div class="serv-note">${factorText}</div>
          <div class="serv-status ${result.miss.length ? 'warn' : 'ok'}">${statusText}</div>
          <div class="ing-table">${mains}${seasonings}</div>
          <p class="seasoning-note">调料按口味增减；没有的调料可用同类替代（如生抽 ⇄ 味极鲜）。</p>
        </div>
        <div>
          <div class="block-title">分步做法 · 共 ${recipe.steps.length} 步</div>
          <div class="steps">${steps}</div>
        </div>
        <div class="tip-box"><b>关键点：</b>${recipe.tip}</div>
        <div class="sheet-foot">
          <button type="button" class="primary small" data-print>🖨 打印这份菜谱</button>
          <button type="button" class="ghost" data-fav="${recipe.id}">${fav ? '♥ 已收藏' : '♡ 收藏'}</button>
          ${recipe.custom ? `<button type="button" class="ghost danger" data-delete="${recipe.id}">删除这条菜谱</button>` : ''}
          <button type="button" class="ghost" data-close>关闭</button>
        </div>
      </div>`;

    lastFocus = document.activeElement;
    const modal = $('#modal');
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#sheet').scrollTop = 0;
    $('.sheet-close', modal).focus();
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ---------- 导入菜谱 ---------- */
  const UNIT_RE = '(kg|g|克|毫升|ml|L|升|个|根|片|瓣|把|颗|只|条|张|盒|碗|杯|大勺|小勺|勺|小块|段)';
  const PANTRY_BY_NAME = new Map(PANTRY.map((p) => [p.name, p]));
  const ING_BY_NAME = new Map(Object.entries(ING).map(([id, meta]) => [meta.name, id]));

  const hashName = (text) => {
    let h = 0;
    for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return 'u' + h.toString(36);
  };

  function parseAmount(raw) {
    const text = raw
      .replace(/^[-*•·]\s*/, '')
      .replace(/^(约|大约|适量|少许)\s*/, '')
      .trim();

    // “半个 / 半根”
    const half = text.match(new RegExp(`^(.*?)\\s*半\\s*${UNIT_RE}?$`, 'i'));
    if (half && half[1]) return { name: half[1].trim(), q: 0.5, unit: half[2] || '' };

    const m = text.match(new RegExp(`^(.*?)\\s*[:：]?\\s*([\\d.]+)\\s*${UNIT_RE}?\\s*$`, 'i'));
    if (!m || !m[1]) return { name: text, q: 0, unit: '' };
    return { name: m[1].replace(/[*＊×x]\s*$/i, '').trim(), q: Number(m[2]) || 0, unit: m[3] || '' };
  }

  function parseRecipeText(text) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return { error: '内容太短了，至少要有菜名、食材和步骤。' };

    const name = lines[0]
      .replace(/^#+\s*/, '')
      .replace(/^(菜名|标题|名称)\s*[:：]\s*/, '')
      .replace(/^[【\[]|[】\]]$/g, '')
      .trim();
    if (!name) return { error: '第一行需要是菜名。' };

    const ingHeader = lines.findIndex((l) => /^(材料|食材|用料|配料|主料|辅料)/.test(l));
    const stepHeader = lines.findIndex((l) => /^(做法|步骤|制作|烹饪|教程)/.test(l));

    const ingStart = ingHeader >= 0 ? ingHeader : 1;
    const ingEnd = stepHeader > ingStart ? stepHeader : lines.length;

    const ingLines = lines
      .slice(ingStart, ingEnd)
      .flatMap((line) =>
        line
          .replace(/^(材料|食材|用料|配料|主料|辅料)\s*[:：]\s*/, '')
          .split(/[、,，;；]/)
          .map((s) => s.trim())
          .filter(Boolean)
      );

    let stepLines;
    if (stepHeader >= 0) {
      const first = lines[stepHeader].replace(/^(做法|步骤|制作|烹饪|教程)\s*[:：]?\s*/, '');
      stepLines = (first ? [first] : []).concat(lines.slice(stepHeader + 1));
    } else {
      stepLines = lines.slice(ingEnd);
    }
    stepLines = stepLines
      .map((l) => l.replace(/^(\d+[.、)）]|[-*•])\s*/, '').trim())
      .filter((l) => l.length > 1);

    const mains = [];
    const seasonings = [];
    const seen = new Set();

    for (const raw of ingLines) {
      const parsed = parseAmount(raw);
      if (!parsed.name || parsed.name.length > 12) continue;
      if (PANTRY_BY_NAME.has(parsed.name)) {
        seasonings.push({ name: parsed.name, q: parsed.q, unit: parsed.unit });
        continue;
      }
      let id = ING_BY_NAME.get(parsed.name);
      if (!id) {
        const candidate = 'u-' + hashName(parsed.name);
        if (!customIngredients[candidate]) {
          customIngredients[candidate] = { name: parsed.name, emoji: '🥢', cat: 'other' };
          ING[candidate] = customIngredients[candidate];
        }
        ING_BY_NAME.set(parsed.name, candidate);
        id = candidate;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      mains.push({ id, q: parsed.q, unit: parsed.unit });
    }

    if (!mains.length) return { error: '没认出食材。建议写成「材料：番茄2个、牛腩500g」这样一行。' };
    if (!stepLines.length) return { error: '没认出步骤。建议在「做法：」下面用 1. 2. 3. 分行写。' };

    return {
      recipe: {
        id: 'u-' + Date.now().toString(36),
        name,
        emoji: '📝',
        desc: '从文字导入的菜谱，用料和步骤来自你粘贴的内容。',
        cuisine: '我的',
        time: 20,
        difficulty: '简单',
        base: 2,
        tags: ['导入'],
        mains,
        seasonings,
        steps: stepLines,
        tip: '这是你自己导入的菜谱，可以随时在详情里删除。',
        custom: true,
      },
    };
  }

  const SAMPLE_IMPORT = `番茄牛腩

材料：番茄2个、牛腩500g、洋葱半个、姜3片、生抽2勺、盐3g

做法：
1. 牛腩切块冷水下锅焯水，撇去浮沫捞出
2. 番茄切块，洋葱切丝
3. 热锅下油炒香洋葱，下牛腩煎到微黄
4. 加番茄炒出汁，倒热水没过，小火炖 60 分钟
5. 加盐和生抽调味，收汁出锅`;

  function openImporter() {
    const sample = SAMPLE_IMPORT;

    $('#sheet').innerHTML = `
      <div class="sheet-head">
        <div class="card-emoji">📥</div>
        <div>
          <h2 id="modalTitle">导入菜谱</h2>
          <p class="sub">把小红书 / 下厨房 / 群里的菜谱文案整段粘进来，自动拆成用料和步骤</p>
        </div>
        <button type="button" class="sheet-close" data-close aria-label="关闭">✕</button>
      </div>
      <div class="sheet-body">
        <textarea id="importText" class="import-area" spellcheck="false" placeholder="${sample
          .replace(/</g, '&lt;')
          .replace(/"/g, '&quot;')}">${''}</textarea>
        <div class="sheet-foot">
          <button type="button" class="primary small" id="importDo">解析并保存</button>
          <button type="button" class="ghost" id="importSample">填入示例</button>
          <button type="button" class="ghost" data-close>取消</button>
        </div>
        <p class="hint" id="importMsg">第一行当菜名；「材料 / 用料」下的内容按顿号、逗号拆成食材（支持 <b>2个</b> / <b>500g</b> / <b>2勺</b>）；「做法 / 步骤」下每行当一步。盐、生抽、料酒这类会归到调料。</p>
      </div>`;

    lastFocus = document.activeElement;
    $('#modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#sheet').scrollTop = 0;
    const area = $('#importText');
    area.addEventListener('input', () => {
      $('#importMsg').classList.remove('is-error');
    });
    area.focus();
  }

  function doImport() {
    const text = $('#importText').value;
    const result = parseRecipeText(text);
    const msg = $('#importMsg');

    if (!result.recipe) {
      msg.textContent = result.error || '解析失败，检查一下格式。';
      msg.classList.add('is-error');
      return;
    }

    const recipe = result.recipe;
    importedRecipes.push(recipe);
    RECIPES.push(recipe);
    writeJSON(IMPORT_KEY, importedRecipes);
    writeJSON(CUSTOM_ING_KEY, customIngredients);

    rebuildIndexes();
    renderCuisineChips();
    renderGroups();
    $('#recipeCount').textContent = String(RECIPES.length);

    state.generated = true;
    renderResults();
    closeModal();
    openRecipe(recipe.id);
  }

  function deleteCustomRecipe(id) {
    const index = RECIPES.findIndex((r) => r.id === id);
    if (index >= 0) RECIPES.splice(index, 1);
    const importedIndex = importedRecipes.findIndex((r) => r.id === id);
    if (importedIndex >= 0) importedRecipes.splice(importedIndex, 1);
    writeJSON(IMPORT_KEY, importedRecipes);

    state.favorites.delete(id);
    writeJSON(KEY.fav, Array.from(state.favorites));

    rebuildIndexes();
    renderGroups();
    $('#recipeCount').textContent = String(RECIPES.length);
    closeModal();
    if (state.generated) renderResults();
    if (!$('#combo').classList.contains('hidden')) renderCombo();
  }

  /* ---------- 收藏 / 主题 ---------- */
  function toggleFavorite(id) {
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    writeJSON(KEY.fav, Array.from(state.favorites));
    $$(`[data-fav="${id}"]`).forEach((btn) => {
      const on = state.favorites.has(id);
      btn.classList.toggle('is-on', on);
      if (btn.classList.contains('fav-btn')) btn.textContent = on ? '♥' : '♡';
      else btn.textContent = on ? '♥ 已收藏' : '♡ 收藏';
    });
    if (state.generated) renderResults();
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('#themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
    $('#themeBtn').classList.toggle('is-on', theme === 'dark');
    writeJSON(KEY.theme, theme);
  }

  /* ---------- 事件绑定 ---------- */
  function setServings(n) {
    state.servings = clampServings(n);
    $('#servings').value = state.servings;
    writeJSON(KEY.servings, state.servings);
    updateBadges();
    refreshResultsIfShown();
  }

  function commitSelection() {
    updateBadges();
    refreshResultsIfShown();
  }

  function startGenerate() {
    state.generated = true;
    renderResults();
    renderCombo();
    const top = $('.result-head');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function bind() {
    $('#servings').addEventListener('input', (e) => {
      const v = e.target.value === '' ? state.servings : e.target.value;
      state.servings = clampServings(v);
      writeJSON(KEY.servings, state.servings);
      updateBadges();
      if (state.generated) renderResults();
    });
    $('#servings').addEventListener('blur', (e) => {
      e.target.value = state.servings;
    });
    $('#minus').addEventListener('click', () => setServings(state.servings - 1));
    $('#plus').addEventListener('click', () => setServings(state.servings + 1));

    $('#groups').addEventListener('change', (e) => {
      const input = e.target.closest('input[type="checkbox"]');
      if (!input) return;
      if (input.checked) state.selected.add(input.value);
      else state.selected.delete(input.value);
      updateGroupCounts();
      commitSelection();
    });

    $('#search').addEventListener('input', (e) => {
      state.query = e.target.value;
      renderGroups();
    });

    $('#clearPicked').addEventListener('click', () => {
      state.selected.clear();
      renderGroups();
      commitSelection();
    });

    $('#pickCommon').addEventListener('click', () => {
      ['egg', 'tomato', 'potato', 'garlic', 'scallion', 'ginger'].forEach((id) => {
        if (ING[id]) state.selected.add(id);
      });
      renderGroups();
      commitSelection();
    });

    const pickAll = (cat) => {
      const ids = (byCat.get(cat) || []).map((i) => i.id);
      const allOn = ids.every((id) => state.selected.has(id));
      ids.forEach((id) => (allOn ? state.selected.delete(id) : state.selected.add(id)));
      renderGroups();
      commitSelection();
    };
    $('#pickVeg').addEventListener('click', () => pickAll('veg'));
    $('#pickMeat').addEventListener('click', () => pickAll('meat'));

    $('#generate').addEventListener('click', startGenerate);
    $('#mobileGenerate').addEventListener('click', startGenerate);

    $('#cuisineRow').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cuisine]');
      if (!btn) return;
      state.cuisine = btn.dataset.cuisine;
      renderCuisineChips();
      if (state.generated) renderResults();
    });

    $('#moodRow').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mood]');
      if (!btn) return;
      const id = btn.dataset.mood;
      state.mood = state.mood === id ? null : id;
      renderMoodChips();
      if (!state.generated) {
        state.generated = true;
        renderResults();
        renderCombo();
      } else {
        renderResults();
        if (!$('#combo').classList.contains('hidden')) renderCombo();
      }
    });

    $('#importBtn').addEventListener('click', openImporter);

    $('#timeChips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-time]');
      if (!btn) return;
      state.maxTime = Number(btn.dataset.time);
      $$('#timeChips .pill').forEach((p) => p.classList.toggle('is-on', p === btn));
      if (state.generated) renderResults();
    });

    $('#readyOnly').addEventListener('change', (e) => {
      state.readyOnly = e.target.checked;
      if (state.generated) renderResults();
    });

    $('#gearChips').addEventListener('change', (e) => {
      const input = e.target.closest('input[type="checkbox"]');
      if (!input) return;
      if (input.checked) state.gear.add(input.value);
      else state.gear.delete(input.value);
      writeJSON(KEY.gear, Array.from(state.gear));
      updateGearBadge();
      refreshResultsIfShown();
    });

    const setAll = (which, all) => {
      const target = which === 'gear' ? state.gear : state.pantry;
      target.clear();
      if (all) (which === 'gear' ? GEAR : PANTRY).forEach((item) => target.add(item.id));
      writeJSON(which === 'gear' ? KEY.gear : KEY.pantry, Array.from(target));
      if (which === 'gear') renderGear();
      else renderPantry();
      refreshResultsIfShown();
    };

    $('#gearAll').addEventListener('click', () => setAll('gear', true));
    $('#gearNone').addEventListener('click', () => setAll('gear', false));
    $('#pantryAll').addEventListener('click', () => setAll('pantry', true));
    $('#pantryNone').addEventListener('click', () => setAll('pantry', false));

    $('#pantryChips').addEventListener('change', (e) => {
      const input = e.target.closest('input[type="checkbox"]');
      if (!input) return;
      if (input.checked) state.pantry.add(input.value);
      else state.pantry.delete(input.value);
      writeJSON(KEY.pantry, Array.from(state.pantry));
      updatePantryBadge();
      refreshResultsIfShown();
    });

    $('#healthChips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-health]');
      if (!btn) return;
      const dim = btn.dataset.health;
      if (state.health.has(dim)) state.health.delete(dim);
      else state.health.add(dim);
      btn.classList.toggle('is-on', state.health.has(dim));
      refreshResultsIfShown();
    });

    $('#favFilterBtn').addEventListener('click', () => {
      state.favOnly = !state.favOnly;
      $('#favFilterBtn').classList.toggle('is-on', state.favOnly);
      $('#favFilterBtn').textContent = state.favOnly ? '♥' : '♡';
      if (!state.favOnly && !state.favorites.size) {
        // 保持按钮状态一致
      }
      state.generated = true;
      renderResults();
    });

    $('#themeBtn').addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    $('#comboBtn').addEventListener('click', () => {
      state.generated = true;
      renderResults();
      renderCombo();
      const box = $('#combo');
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#randomBtn').addEventListener('click', () => {
      const { list } = getResults();
      const pool = list.length ? list : RECIPES.map(evaluate);
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) openRecipe(pick.recipe.id);
    });

    $('#demoBtn').addEventListener('click', () => {
      ['tomato', 'egg', 'potato'].forEach((id) => state.selected.add(id));
      renderGroups();
      commitSelection();
      startGenerate();
    });

    $('#quickPicks').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open]');
      if (btn) openRecipe(btn.dataset.open);
    });

    $('#cards').addEventListener('click', (e) => {
      const favBtn = e.target.closest('[data-fav]');
      if (favBtn) {
        toggleFavorite(favBtn.dataset.fav);
        return;
      }
      const openBtn = e.target.closest('[data-open]');
      if (openBtn) {
        openRecipe(openBtn.dataset.open);
        return;
      }
      const card = e.target.closest('.card');
      if (card) openRecipe(card.dataset.id);
    });

    $('#combo').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open]');
      if (btn) openRecipe(btn.dataset.open);
    });

    $('#modal').addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) {
        closeModal();
        return;
      }
      if (e.target.closest('#importDo')) {
        doImport();
        return;
      }
      if (e.target.closest('#importSample')) {
        const area = $('#importText');
        area.value = SAMPLE_IMPORT;
        area.focus();
        return;
      }
      const delBtn = e.target.closest('[data-delete]');
      if (delBtn) {
        if (delBtn.dataset.confirm === '1') {
          deleteCustomRecipe(delBtn.dataset.delete);
        } else {
          delBtn.dataset.confirm = '1';
          delBtn.textContent = '真的删除？再点一次';
        }
        return;
      }
      const favBtn = e.target.closest('[data-fav]');
      if (favBtn) {
        toggleFavorite(favBtn.dataset.fav);
        return;
      }
      if (e.target.closest('[data-print]')) {
        window.print();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
      if (e.key === '/' && document.activeElement !== $('#search') && !e.target.closest('input')) {
        e.preventDefault();
        $('#search').focus();
      }
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    const savedTheme = readJSON(KEY.theme, 'light');
    applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
    $('#servings').value = state.servings;
    renderCuisineChips();
    renderMoodChips();
    renderGroups();
    renderGear();
    renderPantry();
    $('#recipeCount').textContent = String(RECIPES.length);

    const quick = RECIPES.filter((r) => r.time <= 15 && !r.custom)
      .sort((a, b) => a.time - b.time)
      .slice(0, 5);
    $('#quickPicks').innerHTML = quick
      .map(
        (r) =>
          `<button type="button" class="quick-pick" data-open="${r.id}">${r.emoji} ${r.name} <span class="qp-time">${r.time} 分钟</span></button>`
      )
      .join('');

    bind();
    updateBadges();
  }

  init();
})();
