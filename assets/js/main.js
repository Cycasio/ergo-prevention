async function loadConfig(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`無法載入設定檔: ${path}`);
  return res.json();
}

const state = {
  configs: {},
  nioshTasks: []
};

function switchSection(targetId) {
  document.querySelectorAll('nav button').forEach(btn => {
    const active = btn.dataset.target === targetId;
    btn.classList.toggle('active', active);
  });
  document.querySelectorAll('.section').forEach(sec => {
    sec.classList.toggle('active', sec.id === targetId);
  });
}

function buildField(variable) {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  const label = document.createElement('label');
  const row = document.createElement('div');
  row.className = 'label-row';
  const title = document.createElement('span');
  title.textContent = variable.label;
  row.appendChild(title);
  if (variable.unit) {
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = variable.unit;
    row.appendChild(unit);
  }
  label.appendChild(row);
  let input;
  if (variable.type === 'select') {
    input = document.createElement('select');
    variable.options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      input.appendChild(o);
    });
  } else if (variable.type === 'multi-select') {
    input = document.createElement('div');
    variable.options.forEach(opt => {
      const id = `${variable.key}-${opt.value}`;
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = id;
      chk.value = opt.value;
      chk.dataset.points = opt.points ?? 0;
      const l = document.createElement('label');
      l.setAttribute('for', id);
      l.textContent = opt.label;
      l.style.display = 'block';
      input.appendChild(chk);
      input.appendChild(l);
    });
  } else {
    input = document.createElement('input');
    input.type = variable.type;
    if (variable.min !== undefined) input.min = variable.min;
    if (variable.max !== undefined) input.max = variable.max;
    if (variable.step !== undefined) input.step = variable.step;
  }
  input.id = variable.key;
  input.name = variable.key;
  label.appendChild(input);
  if (variable.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = variable.hint;
    label.appendChild(hint);
  }
  wrapper.appendChild(label);
  return wrapper;
}

function renderForm(form, config) {
  form.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'form-grid';
  config.variables.forEach(v => {
    grid.appendChild(buildField(v));
  });
  form.appendChild(grid);
}

function parseSelectValue(raw) {
  const num = Number(raw);
  const numeric = !Number.isNaN(num) && `${num}` === `${raw}`;
  return numeric ? num : raw;
}

function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function evaluateCondition(cond, context) {
  const expr = cond.replace(/ = /g, ' == ');
  try {
    return Function('ctx', `with(ctx){ return ${expr}; }`)(context);
  } catch (e) {
    console.error('條件解析失敗', cond, e);
    return false;
  }
}

function pickMultiplier(table, variableKey, context) {
  for (const row of table) {
    if (evaluateCondition(row.cond, context)) return row.value;
  }
  return 0;
}

function pickFM(config, interval, posture = 'standing') {
  const rows = config.multipliers.FM[posture] || [];
  return pickMultiplier(rows, 'interval', { interval });
}

function pickCM(config, coupling, posture = 'standing') {
  return config.multipliers.CM[posture][coupling] ?? 0;
}

function pickRiskLevel(riskLevels, key, value) {
  for (const level of riskLevels) {
    const expr = level.criteria || level.range;
    if (!expr) continue;
    const trimmed = expr.replace(/\s+/g, '');
    let matched = false;
    if (trimmed.includes('-')) {
      const [low, high] = trimmed.split('-').map(parseNumber);
      matched = value >= low && value <= high;
    } else if (trimmed.startsWith('>=')) {
      matched = value >= parseNumber(trimmed.replace('>=', ''));
    } else if (trimmed.startsWith('>')) {
      matched = value > parseNumber(trimmed.replace('>', ''));
    } else if (trimmed.startsWith('<=')) {
      matched = value <= parseNumber(trimmed.replace('<=', ''));
    } else if (trimmed.startsWith('<')) {
      matched = value < parseNumber(trimmed.replace('<', ''));
    } else {
      const safeExpr = trimmed.replace(/LI/g, key).replace(/ = /g, ' == ');
      const ctx = { [key]: value };
      try {
        matched = Function('ctx', `with(ctx){ return ${safeExpr}; }`)(ctx);
      } catch (e) {
        console.warn('風險級距解析失敗', expr, e);
      }
    }
    if (matched) return level;
  }
  return riskLevels[riskLevels.length - 1];
}

function renderResult(container, result) {
  if (!result) return;
  const levelClass = result.level === 1 ? 'low' : (result.level === 2 ? 'mid' : 'high');
  container.innerHTML = `
    <div class="level ${levelClass}">等級 ${result.level}｜${result.levelLabel}</div>
    <div><strong>主分值：</strong>${result.score}</div>
    <div class="hint">${result.description}</div>
    <div class="hint">建議：${result.recommendation}</div>
    ${result.items ? `<details style="margin-top:8px;"><summary>細節</summary><pre style="white-space:pre-wrap;">${JSON.stringify(result.items, null, 2)}</pre></details>` : ''}
  `;
}

function saveToStorage(result) {
  localStorage.setItem('ergoResult', JSON.stringify(result, null, 2));
}

function buildErgoResult(tool, score, levelObj, items = [], descriptionOverride) {
  return {
    tool,
    score: Number(score.toFixed ? score.toFixed(2) : score),
    level: levelObj.level,
    levelLabel: levelObj.label,
    description: descriptionOverride || levelObj.description,
    recommendation: levelObj.recommendation,
    items
  };
}

function computeNiosh(values, config) {
  const ctx = { ...values };
  const HM = pickMultiplier(config.multipliers.HM, 'H', ctx);
  const VM = pickMultiplier(config.multipliers.VM, 'V', ctx);
  const DM = pickMultiplier(config.multipliers.DM, 'D', ctx);
  const AM = pickMultiplier(config.multipliers.AM, 'A', ctx);
  const interval = values.frequency > 0 ? 60 / values.frequency : Infinity;
  const FM = pickFM(config, interval, 'standing');
  const CM = pickCM(config, values.coupling, 'standing');
  const RWL = config.constants.LC * HM * VM * DM * AM * FM * CM;
  const LI = RWL > 0 ? values.weight / RWL : Infinity;
  const levelObj = pickRiskLevel(config.riskLevels, 'LI', LI);
  const result = buildErgoResult(config.tool, LI, levelObj, [
    { name: 'RWL', value: Number(RWL.toFixed(2)), unit: 'kg', level: levelObj.level, details: `LC=${config.constants.LC}, HM=${HM}, VM=${VM}, DM=${DM}, AM=${AM}, FM=${FM}, CM=${CM}` }
  ]);
  result.items.push({ name: 'LI', value: Number(LI.toFixed(2)), unit: '', level: levelObj.level, details: `LI = L(${values.weight}) / RWL(${RWL.toFixed(2)})` });
  return { result, LI, RWL };
}

function updateNioshTaskList(container, tasks) {
  container.innerHTML = '';
  tasks.forEach((t, idx) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="tag">任務 ${idx + 1}</div><div>LI：${t.LI.toFixed(2)}</div><div>頻率：${t.frequency}/分</div>`;
    container.appendChild(card);
  });
}

function computeCLI(tasks) {
  if (!tasks.length) return null;
  const totalFreq = tasks.reduce((sum, t) => sum + t.frequency, 0);
  const weighted = totalFreq > 0 ? tasks.reduce((sum, t) => sum + t.LI * t.frequency, 0) / totalFreq : Math.max(...tasks.map(t => t.LI));
  const maxLI = Math.max(...tasks.map(t => t.LI));
  const cli = Math.max(weighted, maxLI);
  return cli;
}

function handleNiosh(config) {
  const form = document.getElementById('niosh-form');
  renderForm(form, config);
  const resultBox = document.getElementById('niosh-result');
  const cliBox = document.getElementById('niosh-cli');
  const taskListBox = document.getElementById('niosh-task-list');

  document.getElementById('calc-niosh').onclick = () => {
    const values = {};
    config.variables.forEach(v => {
      if (v.type === 'multi-select') return;
      const el = form.querySelector(`[name="${v.key}"]`);
      let val = v.type === 'select' ? parseSelectValue(el.value) : parseNumber(el.value);
      values[v.key] = typeof v.min === 'number' || typeof v.max === 'number' ? parseNumber(val) || val : val;
    });
    const { result } = computeNiosh(values, config);
    renderResult(resultBox, result);
    cliBox.style.display = 'none';
    saveToStorage(result);
  };

  document.getElementById('add-niosh-task').onclick = () => {
    const values = {};
    config.variables.forEach(v => {
      if (v.type === 'multi-select') return;
      const el = form.querySelector(`[name="${v.key}"]`);
      let val = v.type === 'select' ? parseSelectValue(el.value) : parseNumber(el.value);
      values[v.key] = typeof v.min === 'number' || typeof v.max === 'number' ? parseNumber(val) || val : val;
    });
    const { LI, RWL } = computeNiosh(values, config);
    state.nioshTasks.push({ ...values, LI, RWL });
    updateNioshTaskList(taskListBox, state.nioshTasks);
    const cli = computeCLI(state.nioshTasks);
    if (cli !== null) {
      const levelObj = pickRiskLevel(config.riskLevels, 'LI', cli);
      const cliResult = buildErgoResult(config.tool, cli, levelObj, state.nioshTasks.map((t, idx) => ({ name: `任務${idx + 1}`, value: Number(t.LI.toFixed(2)), unit: '', level: levelObj.level, details: `頻率=${t.frequency}/分, RWL=${t.RWL.toFixed(2)}kg` })), `複合LI=${cli.toFixed(2)}，取各任務頻率加權且不低於最大LI。`);
      cliBox.style.display = 'block';
      renderResult(cliBox, cliResult);
      saveToStorage(cliResult);
    }
  };

  document.getElementById('clear-niosh-list').onclick = () => {
    state.nioshTasks = [];
    taskListBox.innerHTML = '';
    cliBox.style.display = 'none';
  };
}

function getTimePoints(value, table) {
  for (const row of table) {
    if (row.upto !== undefined && value <= row.upto) return row.points;
  }
  const above = table.find(r => r.above !== undefined);
  return above ? above.points : 0;
}

function getLoadPoints(weight, table) {
  for (const row of table) {
    if (row.range && weight >= row.range[0] && weight <= row.range[1]) return row.points;
    if (row.above !== undefined && weight > row.above) return row.points;
  }
  return 0;
}

function handleKimLHC(config) {
  const form = document.getElementById('kim-lhc-form');
  renderForm(form, config);
  const resultBox = document.getElementById('kim-lhc-result');

  document.getElementById('calc-kim-lhc').onclick = () => {
    const values = {};
    config.variables.forEach(v => {
      const el = form.querySelector(`[name="${v.key}"]`);
      if (v.type === 'multi-select') {
        const selected = Array.from(el.parentElement.querySelectorAll('input[type="checkbox"]:checked'));
        values[v.key] = selected.reduce((sum, c) => sum + parseNumber(c.dataset.points), 0);
      } else {
        values[v.key] = v.type === 'select' ? parseSelectValue(el.value) : parseNumber(el.value);
      }
    });

    const timePts = getTimePoints(values.frequency, config.scoring.timePoints);
    const loadPts = getLoadPoints(values.weight, config.scoring.loadPoints[values.gender]);
    const postureAdds = Math.min(config.scoring.postureAdditionalMax, values.postureTwist + values.postureDistance + values.postureArms + values.postureOverHead);
    const posture = values.postureBase + postureAdds;
    const conditions = values.conditions || 0;
    const indicators = loadPts + values.handling + posture + conditions + values.organization;
    const total = indicators * timePts;
    const levelObj = pickRiskLevel(config.riskLevels, 'score', total);
    const items = [
      { name: '時間評級', value: timePts, unit: '點' },
      { name: '負重評級', value: loadPts, unit: '點' },
      { name: '姿勢評級', value: posture, unit: '點', details: `基礎${values.postureBase} + 附加${postureAdds}` },
      { name: '不良條件', value: conditions, unit: '點' },
      { name: '工作組織', value: values.organization, unit: '點' }
    ];
    const result = buildErgoResult(config.tool, total, levelObj, items, `總分 ${total.toFixed(2)}，落在門檻 ${levelObj.range}。`);
    renderResult(resultBox, result);
    saveToStorage(result);
  };
}

function getIndex(value, breakpoints) {
  for (let i = 0; i < breakpoints.length; i++) {
    if (value <= breakpoints[i]) return i;
  }
  return breakpoints.length;
}

function pickForceScore(level, holdTime, moveCount, config) {
  const table = config.scoring.forceTable[level];
  const holdIdx = getIndex(holdTime, config.scoring.forceBreakpoints.holdingSec);
  const moveIdx = getIndex(moveCount, config.scoring.forceBreakpoints.movingCount);
  const holdVal = table.holding[holdIdx] ?? table.holding[table.holding.length - 1] ?? 0;
  const moveVal = table.moving[moveIdx] ?? table.moving[table.moving.length - 1] ?? 0;
  return holdVal + moveVal;
}

function handleKimMHO(config) {
  const form = document.getElementById('kim-mho-form');
  renderForm(form, config);
  const resultBox = document.getElementById('kim-mho-result');

  document.getElementById('calc-kim-mho').onclick = () => {
    const values = {};
    config.variables.forEach(v => {
      const el = form.querySelector(`[name="${v.key}"]`);
      values[v.key] = v.type === 'select' ? parseSelectValue(el.value) : parseNumber(el.value);
    });
    const timePts = getTimePoints(values.duration, config.scoring.timePoints);
    const leftForce = pickForceScore(values.forceLevelLeft, values.holdTime, values.moveCount, config);
    const rightForce = pickForceScore(values.forceLevelRight, values.holdTime, values.moveCount, config);
    const forceScore = config.scoring.leftRightWorst ? Math.max(leftForce, rightForce) : (leftForce + rightForce) / 2;
    const indicators = forceScore + values.grip + values.handPosture + values.conditions + values.bodyPosture + values.organization;
    const total = indicators * timePts;
    const levelObj = pickRiskLevel(config.riskLevels, 'score', total);
    const items = [
      { name: '時間評級', value: timePts, unit: '點' },
      { name: '施力評級', value: Number(forceScore.toFixed(2)), unit: '點', details: `左手=${leftForce.toFixed(2)}, 右手=${rightForce.toFixed(2)}` },
      { name: '抓握條件', value: values.grip, unit: '點' },
      { name: '手部姿勢', value: values.handPosture, unit: '點' },
      { name: '環境條件', value: values.conditions, unit: '點' },
      { name: '全身姿勢', value: values.bodyPosture, unit: '點' },
      { name: '工作組織', value: values.organization, unit: '點' }
    ];
    const result = buildErgoResult(config.tool, total, levelObj, items, `總分 ${total.toFixed(2)}，乘以時間評級 ${timePts} 取得。`);
    renderResult(resultBox, result);
    saveToStorage(result);
  };
}

function setupNav() {
  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => switchSection(btn.dataset.target));
  });
}

async function bootstrap() {
  setupNav();
  state.configs.niosh = await loadConfig('tools/niosh.json');
  state.configs.kimLHC = await loadConfig('tools/kim_lifting.json');
  state.configs.kimMHO = await loadConfig('tools/kim_upperlimb.json');
  handleNiosh(state.configs.niosh);
  handleKimLHC(state.configs.kimLHC);
  handleKimMHO(state.configs.kimMHO);
}

document.addEventListener('DOMContentLoaded', bootstrap);
