const $ = (selector, root = document) => root.querySelector(selector);

const toast = $("#toast");
let toastTimer = null;
let lastChart = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

function fillSelect(select, values, formatter) {
  select.innerHTML = values.map((value) => `<option value="${value}">${formatter(value)}</option>`).join("");
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function populateBirthFields() {
  const now = new Date();
  const years = Array.from({ length: 101 }, (_, index) => now.getFullYear() - index);
  fillSelect($("#birthYear"), years, (year) => `${year}年`);
  fillSelect($("#birthMonth"), Array.from({ length: 12 }, (_, index) => index + 1), (month) => `${month}月`);
  updateDayOptions();

  $("#birthYear").value = "1990";
  $("#birthMonth").value = "5";
  updateDayOptions();
  $("#birthDay").value = "15";
}

function updateDayOptions() {
  const year = Number($("#birthYear").value || new Date().getFullYear());
  const month = Number($("#birthMonth").value || 1);
  const currentDay = $("#birthDay").value;
  const days = Array.from({ length: daysInMonth(year, month) }, (_, index) => index + 1);
  fillSelect($("#birthDay"), days, (day) => `${day}日`);
  if (days.includes(Number(currentDay))) {
    $("#birthDay").value = currentDay;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function postJson(url, data) {
  if (location.protocol === "file:") {
    throw new Error("请先运行 npm start，并打开 http://127.0.0.1:4177");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function splitPillar(pillar) {
  const text = String(pillar || "--");
  return [text[0] || "-", text[1] || "-"];
}

function renderChart(paipan) {
  const chart = paipan.chart;
  const pillars = [chart.yearPillar, chart.monthPillar, chart.dayPillar, chart.hourPillar];
  const stemsRow = Array.from(document.querySelectorAll(".stem"));
  const branchesRow = Array.from(document.querySelectorAll(".branch"));

  pillars.forEach((pillar, index) => {
    const [stem, branch] = splitPillar(pillar);
    stemsRow[index].textContent = stem;
    branchesRow[index].textContent = branch;
  });

  $("#chartStatus").textContent = "已生成";
  $("#chartSummary").textContent =
    `${paipan.input.year}年${paipan.input.month}月${paipan.input.day}日 ${paipan.input.time}，${chart.timeBranch}时。` +
    ` 日主：${chart.dayMaster || "待定"}；格局：${chart.pattern || "待定"}；旺衰：${chart.strength || "待定"}。` +
    (paipan.luck
      ? ` ${paipan.luck.direction}，${paipan.luck.start.years}年${paipan.luck.start.months}个月${paipan.luck.start.days}天起运，交运：${paipan.luck.start.solarDate}。`
      : "");
}

async function handleSubmit(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const chartInput = {
    year: Number(data.get("birthYear")),
    month: Number(data.get("birthMonth")),
    day: Number(data.get("birthDay")),
    time: String(data.get("birthTime")),
    gender: String(data.get("gender"))
  };

  if (!chartInput.year || !chartInput.month || !chartInput.day || !chartInput.time || !chartInput.gender) {
    showToast("出生年月日、时间和性别都要填写。");
    return;
  }

  $("#chartStatus").textContent = "生成中";
  showToast("正在生成八字四柱。");

  try {
    lastChart = await postJson("/api/paipan", chartInput);
    renderChart(lastChart);
    $("#paidPreview").classList.remove("is-unlocked");
    $("#paidPreview").innerHTML = `<div class="locked-line">付费后展示：四大核心详批、十步大运、逐月流年、明年预告。</div>`;
    showToast("八字四柱已生成。");
  } catch (error) {
    $("#chartStatus").textContent = "失败";
    showToast(error.message || "排盘失败。");
  }
}

function renderReport(report) {
  const core = report.core || {};
  const sections = ["career", "wealth", "relationship", "health"]
    .map((key) => core[key])
    .filter(Boolean)
    .map((section) => `
      <article class="paid-section">
        <h3>${escapeHtml(section.title)}</h3>
        <p>${escapeHtml(section.content)}</p>
        <div class="plain-text">
          <strong>大白话解释</strong>
          <span>${escapeHtml(section.plainText || section.content)}</span>
        </div>
      </article>
    `)
    .join("");

  const luckCycles = (report.luckCycles || [])
    .map((cycle) => `
      <li>
        <strong>${escapeHtml(cycle.ageRange)}</strong>
        <span>${escapeHtml(cycle.pillar)} · ${escapeHtml(cycle.summary)}</span>
        <em>${escapeHtml(cycle.plainText || "")}</em>
      </li>
    `)
    .join("");

  const months = (report.monthlyFortune || [])
    .map((item) => `<li><strong>${escapeHtml(item.month)} · ${escapeHtml(item.level)}</strong><span>${escapeHtml(item.theme)}：${escapeHtml(item.detail)}</span></li>`)
    .join("");

  $("#paidPreview").classList.add("is-unlocked");
  $("#paidPreview").innerHTML = `
    <div class="report-receipt">
      <strong>报告已保存</strong>
      <span>查询码：${escapeHtml(report.reportId || "")}</span>
      <a href="${escapeHtml(report.reportUrl || "#")}" target="_blank" rel="noopener">打开查询链接</a>
      <button class="copy-link-button" type="button" data-copy-report-link>复制链接</button>
    </div>
    ${sections}
    <article class="paid-section">
      <h3>十步大运</h3>
      <ol class="paid-list">${luckCycles}</ol>
    </article>
    <article class="paid-section">
      <h3>流年逐月</h3>
      <ol class="paid-list">${months}</ol>
    </article>
    <article class="paid-section">
      <h3>明年预告</h3>
      <p>${escapeHtml(report.nextYearPreview?.summary || "")}</p>
    </article>
  `;

  const copyButton = $("[data-copy-report-link]");
  if (copyButton && report.reportUrl) {
    copyButton.addEventListener("click", async () => {
      const url = new URL(report.reportUrl, location.origin).toString();
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        showToast("查询链接已复制。");
      } else {
        showToast(url);
      }
    });
  }
}

async function unlockReport() {
  if (!lastChart) {
    $("#paipan").scrollIntoView({ behavior: "smooth", block: "start" });
    showToast("先生成八字四柱，再解锁完整命理。");
    return;
  }

  $("#unlockButton").disabled = true;
  $("#unlockButton").textContent = "正在生成报告...";
  showToast("正在生成完整命理报告。");

  try {
    const report = await postJson("/api/report", { chart: lastChart });
    renderReport(report);
    showToast("完整命理报告已生成。");
  } catch (error) {
    showToast(error.message || "报告生成失败。");
  } finally {
    $("#unlockButton").disabled = false;
    $("#unlockButton").textContent = "解锁全部命理 ¥9.9";
  }
}

function init() {
  populateBirthFields();
  $("#birthYear").addEventListener("change", updateDayOptions);
  $("#birthMonth").addEventListener("change", updateDayOptions);
  $("#baziForm").addEventListener("submit", handleSubmit);
  $("#unlockButton").addEventListener("click", unlockReport);
}

init();
