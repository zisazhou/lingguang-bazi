import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { Solar } from "lunar-javascript";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
loadEnv(join(rootDir, ".env"));

const PORT = Number(process.env.PORT || 4177);
const API_URL = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const YUN_SECT = Number(process.env.BAZI_YUN_SECT || 1) === 2 ? 2 : 1;
const HOST = process.env.HOST || "127.0.0.1";
const dataDir = process.env.DATA_DIR || join(rootDir, "data");
const reportsPath = join(dataDir, "reports.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATABASE_SSL = String(process.env.DATABASE_SSL || "").toLowerCase() === "true";
let dbPool = null;
let dbInitPromise = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function loadEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function randomId() {
  return randomBytes(6).toString("hex");
}

async function readReports() {
  try {
    return JSON.parse(await readFile(reportsPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeReports(reports) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(reportsPath, JSON.stringify(reports, null, 2), "utf8");
}

async function getDbPool() {
  if (!DATABASE_URL) return null;
  if (!dbPool) {
    dbPool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined
    });
  }
  return dbPool;
}

async function initDb() {
  const pool = await getDbPool();
  if (!pool) return null;
  if (!dbInitPromise) {
    dbInitPromise = pool.query(`
      create table if not exists reports (
        id text primary key,
        created_at timestamptz not null default now(),
        chart jsonb not null,
        report jsonb not null
      );
    `);
  }
  await dbInitPromise;
  return pool;
}

async function saveReportRecord({ chart, report }) {
  const pool = await initDb();
  if (pool) {
    let id = randomId();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const result = await pool.query(
          `
            insert into reports (id, chart, report)
            values ($1, $2::jsonb, $3::jsonb)
            returning id, created_at, chart, report
          `,
          [id, JSON.stringify(chart), JSON.stringify(report)]
        );
        const row = result.rows[0];
        return {
          id: row.id,
          createdAt: row.created_at.toISOString(),
          chart: row.chart,
          report: row.report
        };
      } catch (error) {
        if (error.code !== "23505" || attempt === 4) throw error;
        id = randomId();
      }
    }
  }

  const reports = await readReports();
  let id = randomId();
  while (reports[id]) id = randomId();

  const record = {
    id,
    createdAt: new Date().toISOString(),
    chart,
    report
  };
  reports[id] = record;
  await writeReports(reports);
  return record;
}

async function getReportRecord(id) {
  const pool = await initDb();
  if (pool) {
    const result = await pool.query(
      "select id, created_at, chart, report from reports where id = $1 limit 1",
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at.toISOString(),
      chart: row.chart,
      report: row.report
    };
  }

  const reports = await readReports();
  return reports[id] || null;
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function validateBirthInput(input) {
  const year = Number(input.year);
  const month = Number(input.month);
  const day = Number(input.day);
  const time = String(input.time || "");
  const gender = String(input.gender || "");

  if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new Error("出生年份不合法");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("出生月份不合法");
  const maxDay = new Date(year, month, 0).getDate();
  if (!Number.isInteger(day) || day < 1 || day > maxDay) throw new Error("出生日期不合法");
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("出生时间不合法");
  if (!["male", "female"].includes(gender)) throw new Error("性别不合法");

  return { year, month, day, time, gender };
}

function stemElement(stem) {
  return {
    甲: "木",
    乙: "木",
    丙: "火",
    丁: "火",
    戊: "土",
    己: "土",
    庚: "金",
    辛: "金",
    壬: "水",
    癸: "水"
  }[stem] || "";
}

function safeCall(fn, fallback = "") {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function createLuck(input, eightChar) {
  const genderNumber = input.gender === "male" ? 1 : 0;
  const yun = eightChar.getYun(genderNumber, YUN_SECT);
  const startSolar = yun.getStartSolar();
  const daYun = yun.getDaYun(11).slice(1, 11);

  return {
    sect: YUN_SECT,
    direction: yun.isForward() ? "顺排" : "逆排",
    start: {
      years: yun.getStartYear(),
      months: yun.getStartMonth(),
      days: yun.getStartDay(),
      hours: yun.getStartHour(),
      solarDate: startSolar.toYmd(),
      solarDateTime: startSolar.toYmdHms()
    },
    cycles: daYun.map((item, index) => ({
      index: index + 1,
      pillar: item.getGanZhi(),
      startYear: item.getStartYear(),
      endYear: item.getEndYear(),
      startAge: item.getStartAge(),
      endAge: item.getEndAge(),
      ageRange: `${item.getStartAge()}-${item.getEndAge()}岁`,
      yearRange: `${item.getStartYear()}-${item.getEndYear()}年`
    }))
  };
}

function createPaipan(input) {
  const [hour, minute] = input.time.split(":").map(Number);
  const solar = Solar.fromYmdHms(input.year, input.month, input.day, hour, minute, 0);
  const lunar = solar.getLunar();
  const eightChar = lunar.getEightChar();

  const yearPillar = eightChar.getYear();
  const monthPillar = eightChar.getMonth();
  const dayPillar = eightChar.getDay();
  const hourPillar = eightChar.getTime();
  const dayStem = dayPillar[0];
  const timeBranch = hourPillar[1];
  const luck = createLuck(input, eightChar);

  return {
    input,
    chart: {
      yearPillar,
      monthPillar,
      dayPillar,
      hourPillar,
      dayMaster: `${dayStem}${stemElement(dayStem)}`,
      pattern: "待分析",
      strength: "待分析",
      usefulGods: [],
      avoidGods: [],
      timeBranch,
      hiddenStems: {
        year: safeCall(() => eightChar.getYearHideGan()),
        month: safeCall(() => eightChar.getMonthHideGan()),
        day: safeCall(() => eightChar.getDayHideGan()),
        hour: safeCall(() => eightChar.getTimeHideGan())
      },
      tenGods: {
        stems: {
          year: safeCall(() => eightChar.getYearShiShenGan()),
          month: safeCall(() => eightChar.getMonthShiShenGan()),
          day: safeCall(() => eightChar.getDayShiShenGan()),
          hour: safeCall(() => eightChar.getTimeShiShenGan())
        },
        branches: {
          year: safeCall(() => eightChar.getYearShiShenZhi()),
          month: safeCall(() => eightChar.getMonthShiShenZhi()),
          day: safeCall(() => eightChar.getDayShiShenZhi()),
          hour: safeCall(() => eightChar.getTimeShiShenZhi())
        }
      },
      naYin: {
        year: safeCall(() => eightChar.getYearNaYin()),
        month: safeCall(() => eightChar.getMonthNaYin()),
        day: safeCall(() => eightChar.getDayNaYin()),
        hour: safeCall(() => eightChar.getTimeNaYin())
      }
    },
    luck,
    calendar: {
      solar: solar.toYmdHms(),
      lunar: lunar.toString()
    },
    notes: [
      "四柱由 lunar-javascript 确定性排盘生成。",
      `默认按节气定月，起运采用 lunar-javascript sect=${YUN_SECT} 规则。`,
      "格局、旺衰、喜忌交由付费分析阶段结合命盘判断。"
    ]
  };
}

function extractJson(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("模型没有返回 JSON");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

async function callDeepSeek(messages) {
  if (!API_KEY || API_KEY.includes("把你的真实API_KEY") || API_KEY === "sk-your-key-here") {
    throw new Error("缺少 DEEPSEEK_API_KEY，请先在 .env 中配置");
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `DeepSeek 请求失败：${response.status}`;
    throw new Error(message);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 没有返回内容");
  return extractJson(content);
}

function reportPrompt(chart) {
  return [
    {
      role: "system",
      content:
        "你是命理报告 JSON 生成器。只返回合法 JSON，不要 Markdown。内容需克制，不恐吓，不做医学诊断、投资承诺、死亡断语。古籍引用不要编造长原文，引用以短句或原则性转述为主。每个专业分析后必须追加一段大白话解释，让没有命理基础的用户也能看懂。"
    },
    {
      role: "user",
      content: `基于以下命盘生成付费详批 JSON：
${JSON.stringify(chart, null, 2)}

必须返回这个结构：
{
  "core": {
    "career": {"title": "事业", "content": "350到600字专业分析", "plainText": "120到220字大白话解释", "quotes": [{"book": "滴天髓", "quote": "短引文或原则", "explanation": "白话解释"}]},
    "wealth": {"title": "财运", "content": "350到600字专业分析", "plainText": "120到220字大白话解释", "quotes": []},
    "relationship": {"title": "感情", "content": "350到600字专业分析", "plainText": "120到220字大白话解释", "quotes": []},
    "health": {"title": "健康", "content": "350到600字专业分析", "plainText": "120到220字大白话解释", "quotes": []}
  },
  "luckCycles": [
    {"index": 1, "ageRange": "5-14岁", "pillar": "甲子", "summary": "十年专业总论", "plainText": "60到120字大白话解释", "favorable": "吉处", "risk": "风险"}
  ],
  "monthlyFortune": [
    {"month": "正月", "level": "吉/平/慎", "theme": "主题", "detail": "走势说明"}
  ],
  "nextYearPreview": {"year": 2027, "summary": "明年预告"},
  "classicalBooks": ["渊海子平", "滴天髓", "三命通会", "穷通宝典", "子平真诠", "神峰通考"]
}

要求：
- luckCycles 必须正好 10 条。
- luckCycles 必须严格使用命盘 JSON 中 luck.cycles 的 index、ageRange、pillar、startYear、endYear，不得自行改动大运年龄、年份、干支。
- monthlyFortune 必须正好 12 条。
- 四大核心 content 每段 350 到 600 个中文字符。
- 四大核心 plainText 每段 120 到 220 个中文字符，必须少用术语，像给普通用户解释。
- luckCycles 每条必须包含 plainText，用普通话解释这十年对用户意味着什么。`
    }
  ];
}

function mergeDeterministicLuck(report, chart) {
  const cycles = chart?.luck?.cycles;
  if (!Array.isArray(cycles) || cycles.length !== 10) return report;

  const generated = Array.isArray(report.luckCycles) ? report.luckCycles : [];
  report.luckCycles = cycles.map((cycle, index) => ({
    ...generated[index],
    index: cycle.index,
    ageRange: cycle.ageRange,
    pillar: cycle.pillar,
    startYear: cycle.startYear,
    endYear: cycle.endYear,
    yearRange: cycle.yearRange,
    summary: generated[index]?.summary || "",
    plainText: generated[index]?.plainText || generated[index]?.summary || "",
    favorable: generated[index]?.favorable || "",
    risk: generated[index]?.risk || ""
  }));

  return report;
}

function normalizePlainText(report) {
  for (const section of Object.values(report.core || {})) {
    if (section && !section.plainText) {
      section.plainText = section.content || "";
    }
  }
  return report;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderReportHtml(record) {
  const chart = record.chart?.chart || {};
  const report = record.report || {};
  const core = report.core || {};
  const coreHtml = ["career", "wealth", "relationship", "health"]
    .map((key) => core[key])
    .filter(Boolean)
    .map(
      (section) => `
        <article class="paid-section">
          <h3>${escapeHtml(section.title)}</h3>
          <p>${escapeHtml(section.content)}</p>
          <div class="plain-text">
            <strong>大白话解释</strong>
            <span>${escapeHtml(section.plainText || section.content)}</span>
          </div>
        </article>
      `
    )
    .join("");

  const luckHtml = (report.luckCycles || [])
    .map(
      (cycle) => `
        <li>
          <strong>${escapeHtml(cycle.ageRange)}</strong>
          <span>${escapeHtml(cycle.pillar)} · ${escapeHtml(cycle.summary)}</span>
          <em>${escapeHtml(cycle.plainText || "")}</em>
        </li>
      `
    )
    .join("");

  const monthHtml = (report.monthlyFortune || [])
    .map(
      (item) => `<li><strong>${escapeHtml(item.month)} · ${escapeHtml(item.level)}</strong><span>${escapeHtml(item.theme)}：${escapeHtml(item.detail)}</span></li>`
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>命理报告 · ${escapeHtml(record.id)}</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/" aria-label="灵光命盘">
        <span class="brand-mark" aria-hidden="true"><span class="brand-icon"></span></span>
        <span>灵光命盘</span>
      </a>
      <a class="profile-pill" href="/">重新排盘</a>
    </header>
    <main>
      <section class="panel chart-panel">
        <div class="section-row">
          <div>
            <p class="section-kicker">查询码：${escapeHtml(record.id)}</p>
            <h1>完整命理报告</h1>
          </div>
        </div>
        <p class="chart-summary">生成时间：${new Date(record.createdAt).toLocaleString("zh-CN")}。四柱：${escapeHtml(chart.yearPillar)} ${escapeHtml(chart.monthPillar)} ${escapeHtml(chart.dayPillar)} ${escapeHtml(chart.hourPillar)}。</p>
      </section>
      <section class="panel unlock-panel">
        <div class="paid-preview is-unlocked">
          ${coreHtml}
          <article class="paid-section">
            <h3>十步大运</h3>
            <ol class="paid-list">${luckHtml}</ol>
          </article>
          <article class="paid-section">
            <h3>流年逐月</h3>
            <ol class="paid-list">${monthHtml}</ol>
          </article>
          <article class="paid-section">
            <h3>明年预告</h3>
            <p>${escapeHtml(report.nextYearPreview?.summary || "")}</p>
          </article>
        </div>
      </section>
    </main>
    <footer class="site-footer">内容仅作传统文化参考，不替代医疗、法律、投资等专业建议。</footer>
  </body>
</html>`;
}

function assertPaipan(data) {
  const chart = data?.chart;
  const keys = ["yearPillar", "monthPillar", "dayPillar", "hourPillar", "dayMaster", "timeBranch"];
  if (!chart || keys.some((key) => !chart[key])) throw new Error("排盘 JSON 字段不完整");
  return data;
}

function assertReport(data) {
  if (!data?.core || !Array.isArray(data?.luckCycles) || !Array.isArray(data?.monthlyFortune)) {
    throw new Error("报告 JSON 字段不完整");
  }
  if (data.luckCycles.length !== 10) throw new Error("大运数量不是 10 条");
  if (data.monthlyFortune.length !== 12) throw new Error("流年月份不是 12 条");
  return normalizePlainText(data);
}

async function handleApi(req, res) {
  try {
    if (req.method === "POST" && req.url === "/api/paipan") {
      const input = validateBirthInput(await readJsonBody(req));
      const data = assertPaipan(createPaipan(input));
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "POST" && req.url === "/api/report") {
      const body = await readJsonBody(req);
      if (!body?.chart) throw new Error("缺少命盘 chart");
      const report = assertReport(mergeDeterministicLuck(await callDeepSeek(reportPrompt(body.chart)), body.chart));
      const record = await saveReportRecord({ chart: body.chart, report });
      sendJson(res, 200, {
        ...report,
        reportId: record.id,
        reportUrl: `/report/${record.id}`,
        createdAt: record.createdAt
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/report/")) {
      const id = req.url.split("/").pop();
      const record = await getReportRecord(id);
      if (!record) {
        sendJson(res, 404, { error: "报告不存在" });
        return;
      }
      sendJson(res, 200, record);
      return;
    }

    sendJson(res, 404, { error: "接口不存在" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "请求失败" });
  }
}

async function handleStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

  if (urlPath.startsWith("/report/")) {
    const id = urlPath.split("/").filter(Boolean).pop();
    const record = await getReportRecord(id);
    if (!record) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>报告不存在</h1><p>请检查查询链接是否正确。</p>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReportHtml(record));
    return;
  }

  const safePath = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(rootDir, safePath);

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function handleHealth(res) {
  if (!DATABASE_URL) {
    sendJson(res, 200, { ok: true, storage: "json" });
    return;
  }

  try {
    const pool = await initDb();
    await pool.query("select 1");
    sendJson(res, 200, { ok: true, storage: "postgres" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      storage: "postgres",
      error: error.message || "database connection failed"
    });
  }
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    handleHealth(res);
    return;
  }

  if ((req.url || "").startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  handleStatic(req, res);
}).listen(PORT, HOST, () => {
  console.log(`灵光命盘已启动：http://${HOST}:${PORT}`);
});
