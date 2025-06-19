// === State ===
let localData = {};
let isSelecting = false;
let selectedTask = null;
let selectedDays = new Set();

// === Constants ===
const now = new Date();
const monthSelector = document.getElementById('monthSelector');

// === Entry Point ===
initializeUI();
loadConfigAndData();

// === UI Initialization ===
function initializeUI() {
    for (let monthNumber = 0; monthNumber < 12; monthNumber++) {
        const date = new Date(now.getFullYear(), now.getMonth() - monthNumber, 1);
        const option = document.createElement('option');

        option.value = `${date.getFullYear()}-${date.getMonth() + 1}`;
        option.text = `${date.toLocaleString('default', {month: 'long'})} ${date.getFullYear()}`;

        monthSelector.appendChild(option);
    }
    monthSelector.selectedIndex = 0;

    document
        .getElementById('openSettings')
        .addEventListener('click', () => {
            chrome.runtime.openOptionsPage();
        });
    document
        .getElementById('export')
        .addEventListener('click', exportToCSV);

    monthSelector.addEventListener('change', loadWorklogs);
}

function loadConfigAndData() {
    chrome.storage.sync.get(['jiraUrl', 'username', 'taskFilter', 'normHours'], data => {
        if (!data.jiraUrl || !data.username) {
            showError('Укажите настройки.');
            return;
        }
        window.jiraData = data;
        loadWorklogs();
    });
}

// === Data Loading ===
async function loadWorklogs() {
    showLoading();

    const [year, month] = monthSelector.value.split('-').map(Number);
    const issues = await fetchIssues(year, month);

    if (!issues) {
        return;
    }

    localData = await fetchWorklogsForIssues(issues, year, month);
    renderTable();
}

async function fetchIssues(year, month) {
    if (window.jiraData.taskFilter) {
        return window.jiraData.taskFilter.split(',').map(issue => issue.trim());
    }

    const searchUrl = `${window.jiraData.jiraUrl}/rest/api/2/search?jql=worklogAuthor="${window.jiraData.username}" AND worklogDate >= "${year}-${month.toString().padStart(2, '0')}-01"&maxResults=1000&fields=key`;

    try {
        const response = await fetch(searchUrl, {credentials: 'include'});
        const data = await response.json();
        return data.issues.map(issue => issue.key);
    } catch (exception) {
        showError('Ошибка загрузки: ' + exception);
        return null;
    }
}

async function fetchWorklogsForIssues(issues, year, month) {
    const data = {};

    for (const issueKey of issues) {
        const worklogs = await fetchWorklogs(issueKey);

        if (!worklogs) {
            continue;
        }

        worklogs.forEach(worklog => {
            if (worklog.author.name !== window.jiraData.username) {
                return;
            }

            const date = new Date(worklog.started);

            if (date.getFullYear() !== year || date.getMonth() !== (month - 1)) {
                return;
            }

            const day = date.getDate();
            data[issueKey] ??= {};
            data[issueKey][day] ??= [];
            data[issueKey][day].push({
                id: worklog.id,
                started: worklog.started,
                seconds: worklog.timeSpentSeconds,
                comment: worklog.comment || ""
            });
        });
    }

    return data;
}

async function fetchWorklogs(issueKey) {
    const url = `${window.jiraData.jiraUrl}/rest/api/2/issue/${issueKey}/worklog`;

    try {
        const response = await fetch(url, {credentials: 'include'});
        return (await response.json()).worklogs;
    } catch (exception) {
        showError('Ошибка загрузки: ' + exception);
        return null;
    }
}

// === Rendering ===
function renderTable() {
    const [year, month] = monthSelector.value.split('-').map(Number);
    const norm = parseFloat(window.jiraData.normHours) || 8;
    const issues = Object.keys(localData);
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();

    const totalsPerDay = {};

    issues.forEach(issue => {
        for (let day = 1; day <= daysInMonth; day++) {
            const logs = localData[issue]?.[day] || [];
            const totalHours = calculateHours(logs);
            totalsPerDay[day] = (totalsPerDay[day] || 0) + totalHours;
        }
    });

    let html = '<table><thead><tr><th rowspan="2">Задача</th>';

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        html += `<th class="${getDayClass(date, day, today, totalsPerDay[day], norm)}">${date.toLocaleDateString('ru-RU', {weekday: 'short'})}</th>`;
    }

    html += '</tr><tr>';

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        html += `<th class="${getDayClass(date, day, today, totalsPerDay[day], norm)}">${day}</th>`;
    }

    html += '</tr></thead><tbody>';

    issues.forEach(issue => {
        html += `<tr><td>${issue}</td>`;
        for (let day = 1; day <= daysInMonth; day++) {
            const logs = localData[issue]?.[day] || [];
            const totalHours = calculateHours(logs);
            const text = formatHours(totalHours);
            const date = new Date(year, month - 1, day);
            html += `<td class="${getDayClass(date, day, today, totalsPerDay[day], norm)}" data-task="${issue}" data-day="${day}"><b>${text}</b></td>`;
        }
        html += '</tr>';
    });

    html += '<tr><td><b>ИТОГО</b></td>';

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        const text = formatHours(totalsPerDay[day] || 0);
        html += `<td class="${getSummaryClass(date, day, today, totalsPerDay[day], norm)}"><b>${text}</b></td>`;
    }

    html += '</tr></tbody></table>';

    document.getElementById('result').innerHTML = html;
    document.getElementById('total').innerHTML = `<b>Всего за месяц: ${formatHours(Object.values(totalsPerDay).reduce((previous, next) => previous + next, 0))}</b>`;

    enableSelection();
}

// === Selection Logic ===
function enableSelection() {
    document.querySelectorAll("td[data-task]").forEach(cell => {
        cell.addEventListener("mousedown", (event) => {
            if (event.button !== 0) {
                return;
            }

            const task = cell.dataset.task;

            if (!selectedTask) {
                selectedTask = task;
            }

            if (selectedTask !== task) {
                return;
            }

            isSelecting = true;
            selectedDays.clear();

            document.querySelectorAll(".selected").forEach(callBack => {
                callBack.classList.remove("selected");
            });

            cell.classList.add("selected");
            selectedDays.add(parseInt(cell.dataset.day));
        });

        cell.addEventListener("mouseover", () => {
            if (!isSelecting) {
                return;
            }

            const task = cell.dataset.task;

            if (selectedTask !== task) {
                return;
            }

            cell.classList.add("selected");
            selectedDays.add(parseInt(cell.dataset.day));
        });

        cell.addEventListener("mouseup", () => {
            if (!isSelecting) {
                return;
            }

            isSelecting = false;

            openPopup(selectedTask, selectedDays);

            selectedTask = null;
            selectedDays.clear();
        });
    });

    document.addEventListener("mouseup", () => {
        isSelecting = false;
    });
}

// === Popup Logic ===
async function openPopup(task, days) {
    const hoursInput = prompt("Сколько часов поставить?", "8");
    if (hoursInput === null) {
        return;
    }

    const hours = parseFloat(hoursInput.trim());
    if (isNaN(hours) || hours < 0) {
        alert("Некорректное значение");
        return;
    }

    const [year, month] = monthSelector.value.split('-').map(Number);
    const sortedDays = Array.from(days).sort((previous, next) => previous - next);

    for (const day of sortedDays) {
        const worklogs = localData[task]?.[day] || [];

        for (const worklog of worklogs) {
            await fetch(`${window.jiraData.jiraUrl}/rest/api/2/issue/${task}/worklog/${worklog.id}`, {
                method: 'DELETE',
                credentials: 'include'
            });
        }

        const date = new Date(year, month - 1, day, 9, 0, 0);

        await fetch(`${window.jiraData.jiraUrl}/rest/api/2/issue/${task}/worklog`, {
            method: 'POST',
            credentials: 'include',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({started: formatJiraDate(date), timeSpentSeconds: hours * 3600})
        });

        localData[task] ??= {};
        localData[task][day] = [{id: "new", started: formatJiraDate(date), seconds: hours * 3600}];
    }

    renderTable();
}

// === Helpers ===
function calculateHours(worklogs) {
    const totalSeconds = worklogs.reduce((sum, worklog) => sum + worklog.seconds, 0);
    return Math.round((totalSeconds / 3600) * 100) / 100;
}

function formatHours(value) {
    if (value === 0) {
        return "";
    }

    if (Math.round(value) === value) {
        return `${value} ч.`;
    }

    return `${value.toFixed(2)} ч.`;
}

function formatJiraDate(date) {
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}T09:00:00.000+0300`;
}

function getDayClass(date, day, today, total, norm) {
    const classes = [];

    if (today.getFullYear() === date.getFullYear() && today.getMonth() === date.getMonth() && today.getDate() === day) {
        classes.push('today');
    }

    if (date.getDay() === 0 || date.getDay() === 6) {
        classes.push('weekend');
    }

    if (total >= norm) {
        classes.push('over');
    }

    return classes.join(' ');
}

function getSummaryClass(date, day, today, total, norm) {
    let cls = (total >= norm) ? 'over' : '';

    if ((date.getDay() === 0 || date.getDay() === 6) && total === 0) {
        cls = 'weekend';
    }

    if (total > norm) {
        cls = 'over-orange';
    }

    return `${cls} ${today.getDate() === day ? 'today' : ''}`;
}

function showLoading() {
    document.getElementById('result').innerText = 'Загрузка...';
}

function showError(message) {
    document.getElementById('result').innerText = message;
}

function exportToCSV() {
    let csv = "";

    document.querySelectorAll("table tr").forEach(row => {
        const rowData = Array.from(row.querySelectorAll("th,td")).map(cell => cell.innerText);
        csv += rowData.join(";") + "\n";
    });

    const blob = new Blob([csv], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "worklog.csv";
    link.click();
}
