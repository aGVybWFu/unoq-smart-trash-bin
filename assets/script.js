/* ===================================================
   Smart Sort Console - Dashboard Logic
   =================================================== */

// === Stream ===
const streamUrl = `http://${window.location.hostname}:4912/embed`;
document.getElementById('cam-frame').src = streamUrl;
document.getElementById('report-cam-frame').src = streamUrl;

// === Socket.IO ===
const socket = io({
    reconnection: true,
    reconnectionAttempts: 30,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
});

// === DOM Cache ===
const dot = document.getElementById('dot');
const stat = document.getElementById('stat');
const aiText = document.getElementById('ai-text');
const countPlastic = document.getElementById('count-plastic');
const countPaper = document.getElementById('count-paper');
const countTotal = document.getElementById('count-total');
const historyList = document.getElementById('history-list');
const historyCount = document.getElementById('history-count');
const sortIndicator = document.getElementById('sort-indicator');
const sortIndicatorIcon = document.getElementById('sort-indicator-icon');
const sortIndicatorText = document.getElementById('sort-indicator-text');
const piePlastic = document.getElementById('pie-plastic');
const piePaper = document.getElementById('pie-paper');
const piePercent = document.getElementById('pie-percent');
const bboxCanvas = document.getElementById('ai-bbox-canvas');
const reportBboxCanvas = document.getElementById('report-ai-bbox-canvas');

// === State ===
let stats = { plastic: 0, paper: 0, total: 0 };
let dbRecords = [];
let dbTotalRecords = 0;
let dailyCounts = [];
let sortIndicatorTimer = null;
let timeChart = null;
let lastLocalSortTime = 0;
let currentChartType = 'line';
let historyFilterDate = null;
let connectionLogs = [];
let previewChartInstance = null;
let reportResultChart = null;
let currentReportChartType = 'line';
let currentHeatmapYear = new Date().getFullYear();
let currentHeatmapMonth = new Date().getMonth();
let currentTypeFilter = '';
let currentDateFrom = '';
let currentDateTo = '';
let dailyTrendChart = null;
let timeDistChart = null;
let dailyTrendRange = 7; // 7 or 30 days
let testSortCooldown = false;  // 防止前端測試按鈕連點

// === AI Bounding Box State ===
let currentDetections = [];
let lastDetectionTime = 0;
const DETECTION_PERSIST_MS = 800;   // 偵測框持續顯示時間 (ms)
const BBOX_ORIG_WIDTH = 640;        // 原始影格寬度（像素座標用）
const BBOX_ORIG_HEIGHT = 480;       // 原始影格高度（像素座標用）

// === DB Query Callback Queue ===
// Socket.IO responses arrive on a shared channel (db_query_result).
// We use typed queues keyed by _query_type so out-of-order responses are routed correctly.
let dbQueryCallbacks = {
    records: [],
    stats: [],
    daily_counts: [],
    hourly_distribution: [],
    heatmap: []
};

socket.on('db_query_result', (data) => {
    const qt = data._query_type;
    if (qt && dbQueryCallbacks[qt] && dbQueryCallbacks[qt].length > 0) {
        const callback = dbQueryCallbacks[qt].shift();
        callback(data);
    }
});

function changeMonth(delta) {
    currentHeatmapMonth += delta;
    if (currentHeatmapMonth > 11) {
        currentHeatmapMonth = 0;
        currentHeatmapYear++;
    } else if (currentHeatmapMonth < 0) {
        currentHeatmapMonth = 11;
        currentHeatmapYear--;
    }
    renderHeatmap();
}

// === Pagination ===
const ITEMS_PER_PAGE = 10;
let currentPage = 1;

// === Time Formatting ===
function getLocalYMD(d) {
    if (!d || isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseLocalDate(dateStr) {
    if (!dateStr) return new Date(NaN);
    const parts = dateStr.split(/[\/\-]/);
    if (parts.length >= 3) {
        let y = parseInt(parts[0]);
        let m = parseInt(parts[1]) - 1;
        let d = parseInt(parts[2]);
        if (y < 100) {
            // maybe MM/DD/YYYY format
            if (parts[2].length === 4) {
                y = parseInt(parts[2]);
                m = parseInt(parts[0]) - 1;
                d = parseInt(parts[1]);
            }
        }
        return new Date(y, m, d);
    }
    return new Date(dateStr);
}

function getFormattedTime() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const period = hours < 12 ? '上午' : '下午';
    if (hours === 0) hours = 12;
    else if (hours > 12) hours -= 12;
    return `${hours}:${minutes} ${period}`;
}

function formatTimestamp(timestamp) {
    const d = new Date(timestamp * 1000);
    if (isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const period = hours < 12 ? '上午' : '下午';
    if (hours === 0) hours = 12;
    else if (hours > 12) hours -= 12;
    return `${year}-${month}-${day} ${hours}:${minutes} ${period}`;
}

// === DB Query Functions ===
function queryRecords(page, filters) {
    filters = filters || {};
    dbQueryCallbacks.records.push((data) => {
        if (data.error) {
            console.error('queryRecords error:', data.error);
            return;
        }
        dbRecords = data.records || [];
        dbTotalRecords = data.total || 0;
        currentPage = data.page || page;
        renderHistory(dbRecords);
        updatePagination(Math.ceil(dbTotalRecords / ITEMS_PER_PAGE));
    });
    socket.emit('db_query_records', {
        page: page,
        per_page: ITEMS_PER_PAGE,
        type_filter: filters.type_filter || null,
        date_from: filters.date_from || null,
        date_to: filters.date_to || null,
        _query_type: 'records'
    });
}

function queryStats(filters) {
    filters = filters || {};
    dbQueryCallbacks.stats.push((data) => {
        if (data.error) {
            console.error('queryStats error:', data.error);
            return;
        }
        stats.plastic = data.plastic || 0;
        stats.paper = data.paper || 0;
        stats.total = data.total || 0;
        updateStatsDisplay(stats.plastic, stats.paper);
        reportUpdateStats();
    });
    socket.emit('db_query_stats', {
        type_filter: filters.type_filter || null,
        date_from: filters.date_from || null,
        date_to: filters.date_to || null,
        _query_type: 'stats'
    });
}

function queryDailyCounts(filters) {
    filters = filters || {};
    dbQueryCallbacks.daily_counts.push((data) => {
        if (data.error) {
            console.error('queryDailyCounts error:', data.error);
            return;
        }
        if (Array.isArray(data.data)) {
            dailyCounts = data.data;
        }
        updateChart();
        reportUpdateChart();
    });
    socket.emit('db_query_daily_counts', {
        date_from: filters.date_from || null,
        date_to: filters.date_to || null,
        _query_type: 'daily_counts'
    });
}

// ========================================
// Statistics Charts (Daily Trend + Time Distribution)
// ========================================
function createDailyTrendChart(canvasId, days) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (dailyTrendChart) {
        dailyTrendChart.destroy();
        dailyTrendChart = null;
    }

    dailyTrendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: '塑膠',
                    data: [],
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true,
                    pointRadius: 3,
                    pointHoverRadius: 5
                },
                {
                    label: '紙類',
                    data: [],
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true,
                    pointRadius: 3,
                    pointHoverRadius: 5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'tabular-nums', size: 10 }, color: '#6b7280', maxRotation: 45 }
                },
                y: {
                    beginAtZero: true,
                    ticks: { stepSize: 1, font: { family: 'tabular-nums', size: 10 }, color: '#6b7280' },
                    grid: { color: '#f3f4f6' }
                }
            }
        }
    });

    // Query data for the requested range
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
    const dateFrom = getLocalYMD(cutoff);
    const dateTo = getLocalYMD(now);

    dbQueryCallbacks.daily_counts.push(function(data) {
        if (data.error) {
            console.error('createDailyTrendChart error:', data.error);
            return;
        }
        if (!Array.isArray(data.data) || !dailyTrendChart) return;

        // Fill in missing dates
        const dataMap = {};
        data.data.forEach(function(d) { dataMap[d.date] = d; });
        const labels = [];
        const plasticData = [];
        const paperData = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate() + i);
            const dateStr = getLocalYMD(d);
            labels.push(dateStr.slice(5)); // MM-DD
            const entry = dataMap[dateStr];
            plasticData.push(entry ? entry.plastic : 0);
            paperData.push(entry ? entry.paper : 0);
        }

        dailyTrendChart.data.labels = labels;
        dailyTrendChart.data.datasets[0].data = plasticData;
        dailyTrendChart.data.datasets[1].data = paperData;
        dailyTrendChart.update();
    });

    socket.emit('db_query_daily_counts', { date_from: dateFrom, date_to: dateTo, _query_type: 'daily_counts' });
}

function createTimeDistributionChart(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (timeDistChart) {
        timeDistChart.destroy();
        timeDistChart = null;
    }

    timeDistChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Array.from({ length: 24 }, function(_, i) { return String(i).padStart(2, '0') + ':00'; }),
            datasets: [
                {
                    label: '塑膠',
                    data: new Array(24).fill(0),
                    backgroundColor: 'rgba(245, 158, 11, 0.8)',
                    borderColor: '#f59e0b',
                    borderWidth: 1,
                    borderRadius: 3
                },
                {
                    label: '紙類',
                    data: new Array(24).fill(0),
                    backgroundColor: 'rgba(16, 185, 129, 0.8)',
                    borderColor: '#10b981',
                    borderWidth: 1,
                    borderRadius: 3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'tabular-nums', size: 9 }, color: '#6b7280', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
                },
                y: {
                    beginAtZero: true,
                    ticks: { stepSize: 1, font: { family: 'tabular-nums', size: 10 }, color: '#6b7280' },
                    grid: { color: '#f3f4f6' }
                }
            }
        }
    });

    // Query hourly distribution for today
    const todayStr = getLocalYMD(new Date());
    dbQueryCallbacks.hourly_distribution.push(function(data) {
        if (data.error) {
            console.error('createTimeDistributionChart error:', data.error);
            return;
        }
        if (!Array.isArray(data.data) || !timeDistChart) return;

        const plasticArr = new Array(24).fill(0);
        const paperArr = new Array(24).fill(0);
        data.data.forEach(function(d) {
            if (d.hour >= 0 && d.hour < 24) {
                plasticArr[d.hour] = d.plastic;
                paperArr[d.hour] = d.paper;
            }
        });

        timeDistChart.data.datasets[0].data = plasticArr;
        timeDistChart.data.datasets[1].data = paperArr;
        timeDistChart.update();
    });

    socket.emit('db_query_hourly_distribution', { date: todayStr, _query_type: 'hourly_distribution' });
}

function updateStatisticsCharts() {
    createDailyTrendChart('daily-trend-chart', dailyTrendRange);
    createTimeDistributionChart('time-dist-chart');
}

function switchDailyTrendRange(days) {
    dailyTrendRange = days;
    document.getElementById('trend-btn-7').classList.toggle('active', days === 7);
    document.getElementById('trend-btn-30').classList.toggle('active', days === 30);
    createDailyTrendChart('daily-trend-chart', days);
}

// === Init ===
function init() {
    addConnectionLog('網頁端載入完成，初始化系統...', 'info');
    initChart();
    renderHistory([]);
    updatePagination(0);
    renderHeatmap();
    reportInit();
    updateStatisticsCharts();
    switchTopLevel('report'); // Default to report page
}

// ========================================
// Report Page Initialization
// ========================================
function reportInit() {
    reportUpdateStats();
    reportUpdateChart();
    const reportCamFrame = document.getElementById('report-cam-frame');
    if (reportCamFrame && !reportCamFrame.src) {
        reportCamFrame.src = streamUrl;
    }
}

// ========================================
// Top-Level Navigation (Report / Console)
// ========================================
function switchTopLevel(level) {
    // Destroy report chart before hiding report view to prevent zero-dimension errors
    if (level !== 'report') {
        reportDestroyChart();
    }

    // Update top-level tab buttons
    document.querySelectorAll('.nav-tabs:not(.nav-tabs-sub) .tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-btn-${level}`).classList.add('active');

    // Toggle top-level views
    document.getElementById('view-report').classList.toggle('active', level === 'report');
    document.getElementById('view-console').classList.toggle('active', level === 'console');

    // Show/hide sub-tabs
    const subTabs = document.getElementById('sub-tabs');
    if (subTabs) subTabs.style.display = level === 'console' ? 'flex' : 'none';

    // Create report chart after canvas is visible (brief delay for layout settle)
    if (level === 'report') {
        setTimeout(() => reportInitChart(), 100);
    }

    // Default to overview when entering console
    if (level === 'console') {
        switchTab('overview');
    }
}

// ========================================
// Tabs Navigation
// ========================================
function switchTab(tabId) {
    // Hide all sub-tab views (direct children of console-view)
    document.querySelectorAll('.console-view > .view-content').forEach(el => el.classList.remove('active'));
    // Show target view
    document.getElementById(`view-${tabId}`).classList.add('active');
    
    // Update sub-tab buttons only
    document.querySelectorAll('.nav-tabs-sub .tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-btn-${tabId}`).classList.add('active');
}

// ========================================
// Main Logic
// ========================================
function recalcStats() {
    queryStats();
}

function initChart() {
    const ctx = document.getElementById('time-line-chart').getContext('2d');
    
    const colorPlastic = '#f59e0b';
    const colorPlasticBg = currentChartType === 'line' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(245, 158, 11, 0.8)';
    const colorPaper = '#10b981';
    const colorPaperBg = currentChartType === 'line' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(16, 185, 129, 0.8)';

    timeChart = new Chart(ctx, {
        type: currentChartType,
        data: {
            labels: [],
            datasets: [
                {
                    label: '塑膠',
                    data: [],
                    borderColor: colorPlastic,
                    backgroundColor: colorPlasticBg,
                    borderWidth: 2,
                    tension: 0.1,
                    fill: currentChartType === 'line',
                    pointRadius: 2,
                    borderRadius: currentChartType === 'bar' ? 4 : 0
                },
                {
                    label: '紙類',
                    data: [],
                    borderColor: colorPaper,
                    backgroundColor: colorPaperBg,
                    borderWidth: 2,
                    tension: 0.1,
                    fill: currentChartType === 'line',
                    pointRadius: 2,
                    borderRadius: currentChartType === 'bar' ? 4 : 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false } // 隱藏圖例，使用圓餅圖色塊區分類別
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'tabular-nums', size: 10 }, color: '#6b7280' }
                },
                y: {
                    beginAtZero: true,
                    ticks: { stepSize: 1, font: { family: 'tabular-nums', size: 10 }, color: '#6b7280' },
                    grid: { color: '#f3f4f6' }
                }
            }
        }
    });
}

function switchChartType(type) {
    currentChartType = type;
    document.getElementById('btn-line').classList.toggle('active', type === 'line');
    document.getElementById('btn-bar').classList.toggle('active', type === 'bar');
    if (timeChart) timeChart.destroy();
    initChart();
    updateChart();
}

function filterDailyCounts(range) {
    if (range === 'all') return [...dailyCounts];
    const now = new Date();
    let cutoffStr;
    if (range === 'today') {
        cutoffStr = getLocalYMD(now);
    } else {
        const cutoff = new Date(now.getTime() - parseInt(range) * 24 * 60 * 60 * 1000);
        cutoffStr = getLocalYMD(cutoff);
    }
    return dailyCounts.filter(d => d.date >= cutoffStr);
}

function updateChart() {
    if (!timeChart) return;
    const range = document.getElementById('chart-range').value;
    const filtered = filterDailyCounts(range);
    timeChart.data.labels = filtered.map(d => d.date);
    timeChart.data.datasets[0].data = filtered.map(d => d.plastic);
    timeChart.data.datasets[1].data = filtered.map(d => d.paper);
    timeChart.update();
}

// ========================================
// Report Page Chart
// ========================================
function reportInitChart() {
    const canvas = document.getElementById('report-result-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (reportResultChart) {
        reportResultChart.destroy();
        reportResultChart = null;
    }

    const colorPlastic = '#f59e0b';
    const colorPaper = '#10b981';

    if (currentReportChartType === 'pie') {
        const filtered = filterDailyCounts(
            document.getElementById('report-chart-range') ? document.getElementById('report-chart-range').value : 'all'
        );
        let plastic = 0, paper = 0;
        filtered.forEach(d => {
            plastic += d.plastic;
            paper += d.paper;
        });

        reportResultChart = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: ['塑膠', '紙類'],
                datasets: [{
                    data: [plastic, paper],
                    backgroundColor: [colorPlastic, colorPaper],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });
    } else {
        const colorPlasticBg = currentReportChartType === 'line' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(245, 158, 11, 0.8)';
        const colorPaperBg = currentReportChartType === 'line' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(16, 185, 129, 0.8)';

        reportResultChart = new Chart(ctx, {
            type: currentReportChartType,
            data: {
                labels: [],
                datasets: [
                    {
                        label: '塑膠',
                        data: [],
                        borderColor: colorPlastic,
                        backgroundColor: colorPlasticBg,
                        borderWidth: 2,
                        tension: 0.1,
                        fill: currentReportChartType === 'line',
                        pointRadius: 2,
                        borderRadius: currentReportChartType === 'bar' ? 4 : 0
                    },
                    {
                        label: '紙類',
                        data: [],
                        borderColor: colorPaper,
                        backgroundColor: colorPaperBg,
                        borderWidth: 2,
                        tension: 0.1,
                        fill: currentReportChartType === 'line',
                        pointRadius: 2,
                        borderRadius: currentReportChartType === 'bar' ? 4 : 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { font: { family: 'tabular-nums', size: 10 }, color: '#6b7280' }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: { stepSize: 1, font: { family: 'tabular-nums', size: 10 }, color: '#6b7280' },
                        grid: { color: '#f3f4f6' }
                    }
                }
            }
        });
        reportUpdateChart();
    }
}

function reportUpdateChart() {
    if (!reportResultChart) return;

    const rangeEl = document.getElementById('report-chart-range');
    const range = rangeEl ? rangeEl.value : 'all';
    const filtered = filterDailyCounts(range);

    if (currentReportChartType === 'pie') {
        let plastic = 0, paper = 0;
        filtered.forEach(d => {
            plastic += d.plastic;
            paper += d.paper;
        });
        reportResultChart.data.datasets[0].data = [plastic, paper];
        reportResultChart.update();
    } else {
        reportResultChart.data.labels = filtered.map(d => d.date);
        reportResultChart.data.datasets[0].data = filtered.map(d => d.plastic);
        reportResultChart.data.datasets[1].data = filtered.map(d => d.paper);
        reportResultChart.update();
    }
}

function reportDestroyChart() {
    if (reportResultChart) {
        reportResultChart.destroy();
        reportResultChart = null;
    }
}

function reportSwitchChartType(type) {
    currentReportChartType = type;
    document.getElementById('report-btn-line').classList.toggle('active', type === 'line');
    document.getElementById('report-btn-bar').classList.toggle('active', type === 'bar');
    document.getElementById('report-btn-pie').classList.toggle('active', type === 'pie');
    reportInitChart();
}

// ========================================
// AI Bounding Box Drawing
// ========================================
function getBboxColor(label) {
    const lower = (label || '').toLowerCase();
    if (['bottle', 'plastic', 'container', 'plastic_cup'].some(k => lower.includes(k))) {
        return '#f59e0b';
    }
    if (['cup', 'paper', 'mug', 'paper_cup'].some(k => lower.includes(k))) {
        return '#10b981';
    }
    return '#0070f3';
}

function drawBBoxes(canvas, detections) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();

    // Sync canvas internal resolution to display size
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!detections || detections.length === 0) return;

    // Detect normalized vs pixel coordinates
    const first = detections.find(d => (d.x != null || d.y != null));
    const isNormalized = first && first.x != null && first.x <= 1 && first.y != null && first.y <= 1
        && first.width != null && first.width <= 1;

    detections.forEach(d => {
        const label = d.label || '';
        const conf = d.confidence != null ? Math.round(d.confidence * 100) + '%' : '';
        const color = getBboxColor(label);

        let x, y, w, h;
        if (isNormalized) {
            x = (d.x || 0) * canvas.width;
            y = (d.y || 0) * canvas.height;
            w = (d.width || 0) * canvas.width;
            h = (d.height || 0) * canvas.height;
        } else {
            const scaleX = canvas.width / BBOX_ORIG_WIDTH;
            const scaleY = canvas.height / BBOX_ORIG_HEIGHT;
            x = (d.x || 0) * scaleX;
            y = (d.y || 0) * scaleY;
            w = (d.width || 0) * scaleX;
            h = (d.height || 0) * scaleY;
        }

        // Draw bounding box
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);

        // Draw label background and text
        const text = `${label} ${conf}`.trim();
        if (text) {
            ctx.font = 'bold 12px Inter, "Noto Sans TC", sans-serif';
            const tm = ctx.measureText(text);
            const labelH = 20;
            const pad = 6;
            const labelW = tm.width + pad * 2;
            const labelY = y - labelH;

            ctx.fillStyle = color;
            ctx.fillRect(x, labelY, labelW, labelH);

            ctx.fillStyle = '#fff';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x + pad, labelY + labelH / 2);
        }
    });
}

function animateBBoxes() {
    const now = Date.now();
    if (now - lastDetectionTime < DETECTION_PERSIST_MS) {
        drawBBoxes(bboxCanvas, currentDetections);
        drawBBoxes(reportBboxCanvas, currentDetections);
    } else {
        if (bboxCanvas) {
            const ctx = bboxCanvas.getContext('2d');
            ctx.clearRect(0, 0, bboxCanvas.width, bboxCanvas.height);
        }
        if (reportBboxCanvas) {
            const ctx = reportBboxCanvas.getContext('2d');
            ctx.clearRect(0, 0, reportBboxCanvas.width, reportBboxCanvas.height);
        }
    }
    requestAnimationFrame(animateBBoxes);
}
animateBBoxes();

// ========================================
// Socket Handlers
// ========================================
socket.on('connect', () => {
    dot.className = 'status-dot online';
    stat.innerText = '已連線';
    aiText.innerHTML = '系統就緒';
    addConnectionLog('系統已成功連線至伺服器', 'info');
    socket.emit('request_stats', '');
    if (currentTypeFilter || currentDateFrom || currentDateTo) {
        queryRecords(1, {
            type_filter: currentTypeFilter || null,
            date_from: currentDateFrom || null,
            date_to: currentDateTo || null
        });
    } else {
        queryRecords(1);
    }
    queryDailyCounts();
    renderHeatmap();
    updateStatisticsCharts();
});

socket.on('disconnect', () => {
    dot.className = 'status-dot';
    stat.innerText = '已斷線';
    aiText.innerHTML = '已斷線';
    addConnectionLog('與伺服器斷線', 'error');
});

socket.io.on('reconnect_attempt', () => {
    dot.className = 'status-dot reconnecting';
    stat.innerText = '重新連線中...';
    addConnectionLog('嘗試重新連線...', 'warn');
});

socket.on('ai_result', (data) => {
    if (data.objects && data.objects.length) {
        aiText.innerHTML = `[偵測] ${data.objects.join(', ')}`;
        const reportAiText = document.getElementById('report-ai-text');
        if (reportAiText) reportAiText.textContent = `[偵測] ${data.objects.join(', ')}`;
    }
    // Update bounding box data for canvas overlay
    if (data.detections && Array.isArray(data.detections)) {
        currentDetections = data.detections;
        lastDetectionTime = Date.now();
    }
});

socket.on('trash_stats', (data) => {
    stats.plastic = data.plastic || 0;
    stats.paper = data.paper || 0;
    stats.total = data.total || 0;
    updateStatsDisplay(stats.plastic, stats.paper);
    reportUpdateStats();
});

socket.on('sort_event', (data) => {
    if (Date.now() - lastLocalSortTime < 3000) return;
    lastLocalSortTime = Date.now();
    showSortIndicator(data.type);
    if (currentTypeFilter || currentDateFrom || currentDateTo) {
        queryRecords(currentPage, {
            type_filter: currentTypeFilter || null,
            date_from: currentDateFrom || null,
            date_to: currentDateTo || null
        });
    } else {
        queryRecords(currentPage);
    }
    queryStats();
    queryDailyCounts();
    renderHeatmap();
    updateStatisticsCharts();
});

function updateStatsDisplay(plastic, paper) {
    const total = plastic + paper;
    countPlastic.textContent = plastic;
    countPaper.textContent = paper;
    countTotal.textContent = total;
    
    // Pie Chart
    const PIE = 2 * Math.PI * 80;
    if (total === 0) {
        piePlastic.setAttribute('stroke-dasharray', `0 ${PIE}`);
        piePaper.setAttribute('stroke-dasharray', `0 ${PIE}`);
        piePercent.textContent = '0%';
    } else {
        const plArc = (plastic / total) * PIE;
        const paArc = (paper / total) * PIE;
        piePlastic.setAttribute('stroke-dasharray', `${plArc} ${PIE - plArc}`);
        piePaper.setAttribute('stroke-dasharray', `${paArc} ${PIE - paArc}`);
        piePaper.setAttribute('stroke-dashoffset', `-${plArc}`);
        piePercent.textContent = `${Math.round((Math.max(plastic, paper) / total) * 100)}%`;
    }
}

// ========================================
// Report Page Stats Update
// ========================================
function reportUpdateStats() {
    const elPlastic = document.getElementById('report-count-plastic');
    const elPaper = document.getElementById('report-count-paper');
    const elTotal = document.getElementById('report-count-total');
    const elPiePlastic = document.getElementById('report-pie-plastic');
    const elPiePaper = document.getElementById('report-pie-paper');
    const elPiePercent = document.getElementById('report-pie-percent');
    if (!elPlastic) return;

    const plastic = stats.plastic;
    const paper = stats.paper;
    const total = stats.total;

    elPlastic.textContent = plastic;
    elPaper.textContent = paper;
    elTotal.textContent = total;

    const PIE = 2 * Math.PI * 80;
    if (total === 0) {
        elPiePlastic.setAttribute('stroke-dasharray', `0 ${PIE}`);
        elPiePaper.setAttribute('stroke-dasharray', `0 ${PIE}`);
        elPiePercent.textContent = '0%';
    } else {
        const plArc = (plastic / total) * PIE;
        const paArc = (paper / total) * PIE;
        elPiePlastic.setAttribute('stroke-dasharray', `${plArc} ${PIE - plArc}`);
        elPiePaper.setAttribute('stroke-dasharray', `${paArc} ${PIE - paArc}`);
        elPiePaper.setAttribute('stroke-dashoffset', `-${plArc}`);
        elPiePercent.textContent = `${Math.round((Math.max(plastic, paper) / total) * 100)}%`;
    }
}

// ========================================
// History & Heatmap
// ========================================
function renderHistory(records) {
    historyList.innerHTML = '';
    const emptyEl = `<div class="empty-state">尚無活動紀錄</div>`;
    
    if (!records || records.length === 0) {
        historyList.innerHTML = emptyEl;
        historyCount.textContent = '0';
        updatePagination(0);
        return;
    }

    records.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const typeLabel = item.type === 'plastic' ? '塑膠瓶' : '紙杯';
        const timeDisplay = formatTimestamp(item.timestamp);
        div.innerHTML = `
            <div class="hist-type">${typeLabel}</div>
            <span class="hist-time">${timeDisplay}</span>
        `;
        historyList.appendChild(div);
    });

    historyCount.textContent = dbTotalRecords;
}

function applyHistoryFilter() {
    currentTypeFilter = document.getElementById('history-type-filter').value;
    currentDateFrom = document.getElementById('history-date-from').value;
    currentDateTo = document.getElementById('history-date-to').value;
    currentPage = 1;
    queryRecords(1, {
        type_filter: currentTypeFilter || null,
        date_from: currentDateFrom || null,
        date_to: currentDateTo || null
    });
}

function clearHistoryFilter() {
    document.getElementById('history-type-filter').value = '';
    document.getElementById('history-date-from').value = '';
    document.getElementById('history-date-to').value = '';
    currentTypeFilter = '';
    currentDateFrom = '';
    currentDateTo = '';
    currentPage = 1;
    queryRecords(1);
}

function updatePagination(totalPages) {
    const pagination = document.getElementById('pagination');
    if (totalPages <= 1) {
        pagination.style.display = 'none';
        return;
    }
    pagination.style.display = 'flex';
    document.getElementById('page-info').textContent = `${currentPage} / ${totalPages}`;
    document.getElementById('page-prev').disabled = currentPage <= 1;
    document.getElementById('page-next').disabled = currentPage >= totalPages;
    document.getElementById('page-input').value = currentPage;
    document.getElementById('page-input').max = totalPages;
}

function changePage(delta) {
    currentPage += delta;
    if (currentTypeFilter || currentDateFrom || currentDateTo) {
        queryRecords(currentPage, {
            type_filter: currentTypeFilter || null,
            date_from: currentDateFrom || null,
            date_to: currentDateTo || null
        });
    } else if (historyFilterDate) {
        queryRecords(currentPage, { date_from: historyFilterDate, date_to: historyFilterDate });
    } else {
        queryRecords(currentPage);
    }
}

function jumpPage(val) {
    const page = parseInt(val);
    if (page > 0) {
        currentPage = page;
        if (currentTypeFilter || currentDateFrom || currentDateTo) {
            queryRecords(currentPage, {
                type_filter: currentTypeFilter || null,
                date_from: currentDateFrom || null,
                date_to: currentDateTo || null
            });
        } else if (historyFilterDate) {
            queryRecords(currentPage, { date_from: historyFilterDate, date_to: historyFilterDate });
        } else {
            queryRecords(currentPage);
        }
    }
}

// Render Calendar style Heatmap
function renderHeatmap() {
    const grid = document.getElementById('heatmap-grid');
    const scrollContainer = document.querySelector('.heatmap-scroll');
    if (!grid) return;
    grid.innerHTML = '';
    
    const label = document.getElementById('calendar-month-year');
    if (label) {
        label.textContent = `${currentHeatmapYear}年 ${currentHeatmapMonth + 1}月`;
    }
    
    // Add calendar headers if not exist
    if (!document.getElementById('calendar-header')) {
        const header = document.createElement('div');
        header.id = 'calendar-header';
        header.className = 'calendar-header';
        ['日', '一', '二', '三', '四', '五', '六'].forEach(day => {
            const d = document.createElement('div');
            d.textContent = day;
            header.appendChild(d);
        });
        scrollContainer.insertBefore(header, grid);
    }

    // Query DB for last 30 days of daily counts
    function renderBoxes(dailyCountsMap) {
        const firstDayOfMonth = new Date(currentHeatmapYear, currentHeatmapMonth, 1);
        const startOffset = firstDayOfMonth.getDay(); // 0 (Sun) to 6 (Sat)
        const lastDayOfMonth = new Date(currentHeatmapYear, currentHeatmapMonth + 1, 0);
        const daysInMonth = lastDayOfMonth.getDate();
        const daysInPrevMonth = new Date(currentHeatmapYear, currentHeatmapMonth, 0).getDate();
        
        // Usually a month takes 5 or 6 weeks. We use 42 cells (6 weeks) to maintain a consistent grid layout.
        for (let i = 0; i < 42; i++) {
            let dateObj;
            let isCurrentMonth = false;
            
            if (i < startOffset) {
                dateObj = new Date(currentHeatmapYear, currentHeatmapMonth - 1, daysInPrevMonth - startOffset + i + 1);
            } else if (i < startOffset + daysInMonth) {
                dateObj = new Date(currentHeatmapYear, currentHeatmapMonth, i - startOffset + 1);
                isCurrentMonth = true;
            } else {
                dateObj = new Date(currentHeatmapYear, currentHeatmapMonth + 1, i - startOffset - daysInMonth + 1);
            }

            // Stop rendering if we've finished the month and completed the row
            if (i >= 35 && !isCurrentMonth && (i - startOffset - daysInMonth + 1) > 0) {
                if (i % 7 === 0) break;
            }

            const year = dateObj.getFullYear();
            const month = String(dateObj.getMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            
            const count = dailyCountsMap[dateStr] || 0;
            let level = 0;
            if (count >= 20) level = 4;
            else if (count >= 10) level = 3;
            else if (count >= 5) level = 2;
            else if (count >= 1) level = 1;

            const box = document.createElement('div');
            box.className = `heat-box level-${level}`;
            box.textContent = dateObj.getDate();
            
            const today = new Date();
            const isFuture = dateObj > today;
            
            if (!isCurrentMonth) {
                box.style.opacity = '0.3';
            }
            
            if (isFuture) {
                box.style.opacity = isCurrentMonth ? '0.2' : '0.1';
                box.style.pointerEvents = 'none';
            } else {
                box.title = `${dateObj.toLocaleDateString()}: ${count} 件`;
                box.onclick = () => filterHistoryByDate(dateStr);
                box.style.cursor = 'pointer';
                
                if (historyFilterDate === dateStr) {
                    box.style.boxShadow = '0 0 0 2px var(--accent-blue)';
                    box.style.zIndex = '1';
                    box.style.position = 'relative';
                }
            }
            
            grid.appendChild(box);
        }
    }

    if (socket.connected) {
        dbQueryCallbacks.heatmap.push(function(data) {
            if (data.error) {
                console.error('renderHeatmap query error:', data.error);
                return;
            }

            const dailyCountsMap = {};
            if (Array.isArray(data.data)) {
                data.data.forEach(d => {
                    dailyCountsMap[d.date] = d.total;
                });
            }

            renderBoxes(dailyCountsMap);
        });
        socket.emit('db_query_heatmap', { _query_type: 'heatmap' });
    } else {
        renderBoxes({});
    }
}

function filterHistoryByDate(dateStr) {
    if (historyFilterDate === dateStr) {
        historyFilterDate = null; // 取消篩選
    } else {
        historyFilterDate = dateStr;
    }
    currentPage = 1;
    if (historyFilterDate) {
        queryRecords(1, { date_from: historyFilterDate, date_to: historyFilterDate });
    } else {
        queryRecords(1);
    }
    renderHeatmap();
}

function clearHistory() {
    if (confirm("確定要永久清除所有資料嗎？")) {
        socket.emit('reset_stats', '');
        dbRecords = [];
        dbTotalRecords = 0;
        dailyCounts = [];
        stats = { plastic: 0, paper: 0, total: 0 };
        currentPage = 1;
        historyFilterDate = null;
        currentTypeFilter = '';
        currentDateFrom = '';
        currentDateTo = '';
        document.getElementById('history-type-filter').value = '';
        document.getElementById('history-date-from').value = '';
        document.getElementById('history-date-to').value = '';
        renderHistory([]);
        updatePagination(0);
        renderHeatmap();
        updateChart();
        updateStatsDisplay(0, 0);
        reportUpdateStats();
    }
}

function showSortIndicator(type) {
    sortIndicatorIcon.textContent = type === 'plastic' ? '🧴' : '🥤';
    sortIndicatorText.textContent = type === 'plastic' ? '分類塑膠中' : '分類紙類中';
    sortIndicator.classList.remove('hidden');
    clearTimeout(sortIndicatorTimer);
    sortIndicatorTimer = setTimeout(() => sortIndicator.classList.add('hidden'), 2000);
}

// ========================================
// Controls
// ========================================
let testSortCallCount = 0; // 調試用：記錄 testSort 被呼叫次數

function testSort(type) {
    testSortCallCount++;
    console.log(`[DEBUG] testSort called #${testSortCallCount} for ${type}`);
    if (testSortCooldown) {
        console.log(`[DEBUG] testSort blocked by cooldown`);
        return;
    }
    testSortCooldown = true;
    setTimeout(() => { testSortCooldown = false; }, 5000); // 5 秒防抖，與後端 COOLDOWN_SECONDS 一致
    localDoSort(type);
    if (socket.connected) socket.emit('test_sort', type);
}

function localDoSort(type) {
    lastLocalSortTime = Date.now();
    showSortIndicator(type);
    // Delayed refresh to allow server to process the record
    setTimeout(() => {
        if (currentTypeFilter || currentDateFrom || currentDateTo) {
            queryRecords(currentPage, {
                type_filter: currentTypeFilter || null,
                date_from: currentDateFrom || null,
                date_to: currentDateTo || null
            });
        } else {
            queryRecords(currentPage);
        }
        queryStats();
        queryDailyCounts();
        renderHeatmap();
    }, 500);
}

function resetStats() {
    clearHistory();
}

function exportToCSV() {
    // Query all records from DB via Socket.IO
    dbQueryCallbacks.records.push(function(data) {
        const records = data.records;
        if (!records || records.length === 0) {
            alert("沒有可以匯出的資料！");
            return;
        }

        // CSV header
        let csv = "ID,類型,時間,信心度\n";

        records.forEach(function(rec) {
            const id = rec.id != null ? rec.id : '';
            // Translate type
            const typeLabel = rec.type === 'plastic' ? '塑膠' : rec.type === 'paper' ? '紙杯' : (rec.type || '');
            // Convert Unix epoch timestamp to YYYY-MM-DD HH:MM:SS
            let timeStr = '';
            if (rec.timestamp) {
                const d = new Date(rec.timestamp * 1000);
                if (!isNaN(d.getTime())) {
                    const yyyy = d.getFullYear();
                    const mm = String(d.getMonth() + 1).padStart(2, '0');
                    const dd = String(d.getDate()).padStart(2, '0');
                    const hh = String(d.getHours()).padStart(2, '0');
                    const min = String(d.getMinutes()).padStart(2, '0');
                    const ss = String(d.getSeconds()).padStart(2, '0');
                    timeStr = yyyy + '-' + mm + '-' + dd + ' ' + hh + ':' + min + ':' + ss;
                }
            }
            // Confidence as percentage or empty
            let confStr = '';
            if (rec.confidence != null && rec.confidence !== '') {
                confStr = Math.round(rec.confidence * 100) + '%';
            }

            csv += id + ',' + typeLabel + ',' + timeStr + ',' + confStr + '\n';
        });

        // UTF-8 BOM for Excel Chinese support
        const BOM = '\uFEFF';
        const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;

        // Filename with today's date
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        link.download = '回收記錄_' + yyyy + '-' + mm + '-' + dd + '.csv';

        link.click();
        URL.revokeObjectURL(url);
    });

    socket.emit('db_query_records', { page: 1, per_page: 10000, _query_type: 'records' });
}

function parse12HourTime(timeStr) {
    if (!timeStr) return null;
    const match = timeStr.match(/(\d+):(\d+)\s*(上午|下午)/);
    if (!match) return null;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const period = match[3];
    if (period === '下午' && h < 12) h += 12;
    if (period === '上午' && h === 12) h = 0;
    return { h, m, totalMinutes: h * 60 + m };
}

function parse24HourTime(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':');
    if (parts.length < 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    return { h, m, totalMinutes: h * 60 + m };
}

function toggleCustomRange() {
    const range = document.getElementById('export-time-range').value;
    const customDiv = document.getElementById('custom-range-inputs');
    customDiv.style.display = range === 'custom' ? 'flex' : 'none';
}

function previewCustomChart() {
    const range = document.getElementById('export-time-range').value;
    const chartType = document.getElementById('export-chart-type').value;

    // Build date filters for DB query
    let filters = {};
    const now = new Date();
    const todayStr = getLocalYMD(now);

    if (range === 'today') {
        filters.date_from = todayStr;
        filters.date_to = todayStr;
    } else if (range === 'custom') {
        const startDate = document.getElementById('export-start-date').value.trim();
        const endDate = document.getElementById('export-end-date').value.trim();
        if (startDate) filters.date_from = startDate;
        if (endDate) filters.date_to = endDate;
    } else if (range !== 'all') {
        const days = parseInt(range);
        const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
        filters.date_from = getLocalYMD(cutoff);
    }

    dbQueryCallbacks.daily_counts.push(function(data) {
        if (!Array.isArray(data.data) || data.data.length === 0) {
            alert('在此條件下找不到任何資料！');
            return;
        }

        document.getElementById('export-preview-area').classList.remove('hidden');

        // Delay chart creation to let the DOM layout settle after unhiding
        setTimeout(() => {
            const ctx = document.getElementById('preview-chart').getContext('2d');
            if (previewChartInstance) {
                previewChartInstance.destroy();
            }

            if (chartType === 'pie') {
                let plastic = 0, paper = 0;
                data.data.forEach(d => {
                    plastic += d.plastic;
                    paper += d.paper;
                });
                
                previewChartInstance = new Chart(ctx, {
                    type: 'pie',
                    data: {
                        labels: ['塑膠', '紙類'],
                        datasets: [{
                            data: [plastic, paper],
                            backgroundColor: ['#f59e0b', '#10b981'],
                            borderWidth: 0
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { position: 'bottom' }
                        }
                    }
                });
            } else {
                const dates = data.data.map(d => d.date);
                const plasticData = data.data.map(d => d.plastic);
                const paperData = data.data.map(d => d.paper);

                previewChartInstance = new Chart(ctx, {
                    type: chartType,
                    data: {
                        labels: dates,
                        datasets: [
                            { label: '塑膠', data: plasticData, backgroundColor: '#f59e0b', borderColor: '#f59e0b', tension: 0.3 },
                            { label: '紙類', data: paperData, backgroundColor: '#10b981', borderColor: '#10b981', tension: 0.3 }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: { beginAtZero: true, ticks: { stepSize: 1 } }
                        }
                    }
                });
            }
        }, 50);
    });

    socket.emit('db_query_daily_counts', { ...filters, _query_type: 'daily_counts' });
}

function downloadCustomChart() {
    const target = document.getElementById('preview-canvas-wrapper');
    if (typeof html2canvas !== 'undefined') {
        html2canvas(target, { backgroundColor: "#ffffff", scale: 2 }).then(canvas => {
            const link = document.createElement('a');
            link.download = `CustomChart_${Date.now()}.png`;
            link.href = canvas.toDataURL();
            link.click();
        });
    } else {
        alert("匯出套件載入失敗，請檢查網路連線。");
    }
}

function addConnectionLog(msg, type = 'info') {
    const now = new Date();
    const timeStr = now.toLocaleTimeString();
    const dateStr = now.toLocaleDateString();
    const fullTime = `${dateStr} ${timeStr}`;
    connectionLogs.push({ time: fullTime, msg, type });
    
    const terminal = document.getElementById('conn-log-content');
    if (!terminal) return;
    
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `<span class="log-time">[${fullTime}]</span><span class="log-msg ${type}">${msg}</span>`;
    terminal.appendChild(div);
    
    const container = document.getElementById('conn-log-terminal');
    container.scrollTop = container.scrollHeight;
}

function exportConnectionLogs() {
    if (connectionLogs.length === 0) return alert("沒有連線日誌可匯出！");
    let txt = "=== 系統連線日誌 ===\n\n";
    connectionLogs.forEach(log => {
        txt += `[${log.time}] ${log.msg}\n`;
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8;' }));
    link.download = `ConnectionLog_${Date.now()}.txt`;
    link.click();
}

init();

// ========================================
// Report Page Code Tab Switching
// ========================================
function reportSwitchCodeTab(tabName) {
  // Toggle tab buttons
  document.querySelectorAll('.report-tab-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });
  // Toggle code blocks
  document.getElementById('report-code-cpp').classList.toggle('hidden', tabName !== 'cpp');
  document.getElementById('report-code-python').classList.toggle('hidden', tabName !== 'python');
}