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

// === Progress Bar Functions ===
function showProgress(text = 'Загрузка...') {
    const progressContainer = document.getElementById('progressContainer');
    const progressText = progressContainer.querySelector('.progress-text');
    const progressFill = progressContainer.querySelector('.progress-fill');

    progressContainer.style.display = 'block';
    progressText.textContent = text;
    progressFill.style.width = '0%';

    document.getElementById('result').innerHTML = '';
    document.getElementById('total').innerHTML = '';
}

function updateProgress(current, total, text = null) {
    const progressContainer = document.getElementById('progressContainer');
    const progressText = progressContainer.querySelector('.progress-text');
    const progressFill = progressContainer.querySelector('.progress-fill');

    const percentage = Math.round((current / total) * 100);
    progressFill.style.width = `${percentage}%`;

    if (text) {
        progressText.textContent = text;
    } else {
        progressText.textContent = `Загрузка worklogs: ${current} из ${total} задач (${percentage}%)`;
    }
}

function hideProgress() {
    const progressContainer = document.getElementById('progressContainer');
    progressContainer.style.display = 'none';
}

// === Data Loading ===
async function loadWorklogs() {
    showProgress('Поиск задач...');

    const [year, month] = monthSelector.value.split('-').map(Number);
    const issues = await fetchIssues(year, month);

    if (!issues) {
        hideProgress();
        return;
    }

    if (issues.length === 0) {
        hideProgress();
        showError('Задачи не найдены для указанного периода.');
        return;
    }

    updateProgress(0, issues.length, `Найдено задач: ${issues.length}`);
    localData = await fetchWorklogsForIssues(issues, year, month);
    hideProgress();
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
    let processed = 0;

    for (const issueKey of issues) {
        const worklogs = await fetchWorklogs(issueKey);
        processed++;
        updateProgress(processed, issues.length);

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
        console.error(`Ошибка загрузки worklogs для ${issueKey}:`, exception);
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
        const issueUrl = `${window.jiraData.jiraUrl}/browse/${issue}`;
        html += `<tr><td><a href="${issueUrl}" target="_blank">${issue}</a></td>`;
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
    let sortedDays = Array.from(days).sort((previous, next) => previous - next);

    // Проверяем наличие выходных в выбранном диапазоне
    const weekendDays = sortedDays.filter(day => {
        const date = new Date(year, month - 1, day);
        const dayOfWeek = date.getDay();
        return dayOfWeek === 0 || dayOfWeek === 6; // воскресенье или суббота
    });

    if (weekendDays.length > 0) {
        const weekendDatesFormatted = weekendDays.map(day => {
            const date = new Date(year, month - 1, day);
            return date.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
        }).join(', ');

        const skipWeekends = confirm(
            `В выбранном диапазоне есть выходные дни (${weekendDatesFormatted}).\n\nПропустить выходные и не заполнять в них время?`
        );

        if (skipWeekends) {
            sortedDays = sortedDays.filter(day => !weekendDays.includes(day));

            if (sortedDays.length === 0) {
                alert("После исключения выходных не осталось дней для заполнения.");
                return;
            }
        }
    }

    showProgress(`Обновление worklogs для ${task}...`);

    // Создаем массив промисов для параллельной обработки всех дней
    const dayPromises = sortedDays.map(async (day, index) => {
        const worklogs = localData[task]?.[day] || [];

        // Удаление существующих worklogs (параллельно для всех worklogs одного дня)
        const deletePromises = worklogs.map(async (worklog) => {
            try {
                const deleteResponse = await fetch(`${window.jiraData.jiraUrl}/rest/api/2/issue/${task}/worklog/${worklog.id}`, {
                    method: 'DELETE',
                    credentials: 'include'
                });

                if (!deleteResponse.ok) {
                    console.error(`Ошибка удаления worklog ${worklog.id}: ${deleteResponse.status} ${deleteResponse.statusText}`);
                    throw new Error(`HTTP ${deleteResponse.status}: ${deleteResponse.statusText}`);
                }
            } catch (error) {
                console.error(`Ошибка при удалении worklog ${worklog.id}:`, error);
                throw error;
            }
        });

        await Promise.allSettled(deletePromises);

        // Если указано 0 часов, только удаляем существующие worklogs, не создавая новый
        if (hours === 0) {
            return {day, success: true, data: []};
        }

        // Создание нового worklog
        const date = new Date(year, month - 1, day, 9, 0, 0);

        try {
            const createResponse = await fetch(`${window.jiraData.jiraUrl}/rest/api/2/issue/${task}/worklog`, {
                method: 'POST',
                credentials: 'include',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({started: formatJiraDate(date), timeSpentSeconds: hours * 3600})
            });

            if (!createResponse.ok) {
                const errorText = await createResponse.text();
                throw new Error(`HTTP ${createResponse.status}: ${errorText}`);
            }

            const createdWorklog = await createResponse.json();
            return {
                day,
                success: true,
                data: [{id: createdWorklog.id, started: formatJiraDate(date), seconds: hours * 3600}]
            };
        } catch (error) {
            console.error(`Ошибка при создании worklog для дня ${day}:`, error);
            return {day, success: false, error: error.message};
        }
    });

    // Ожидаем завершения всех операций и обновляем прогресс
    let completed = 0;
    const results = await Promise.allSettled(dayPromises.map(async (promise, index) => {
        const result = await promise;
        completed++;
        updateProgress(completed, sortedDays.length, `Обновлено дней: ${completed} из ${sortedDays.length}`);
        return result;
    }));

    // Обновляем localData на основе результатов
    const errors = [];
    results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.success) {
            const {day, data} = result.value;
            localData[task] ??= {};
            localData[task][day] = data;
        } else if (result.status === 'fulfilled' && !result.value.success) {
            errors.push(`День ${result.value.day}: ${result.value.error}`);
        } else {
            errors.push(`День ${sortedDays[index]}: ${result.reason?.message || 'Неизвестная ошибка'}`);
        }
    });

    hideProgress();

    if (errors.length > 0) {
        alert(`Ошибки при обновлении worklogs:\n${errors.join('\n')}`);
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