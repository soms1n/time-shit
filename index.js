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
            chrome.windows.create({
                url: chrome.runtime.getURL('popup.html'),
                type: 'popup',
                width: 500,
                height: 600
            });
        });
    document
        .getElementById('export')
        .addEventListener('click', exportToCSV);

    document
        .getElementById('autoFill')
        .addEventListener('click', toggleAutoFillPanel);

    document
        .getElementById('cancelAutoFill')
        .addEventListener('click', hideAutoFillPanel);

    document
        .getElementById('applyAutoFill')
        .addEventListener('click', applyAutoFill);

    document
        .getElementById('randomTasks')
        .addEventListener('change', handleTaskSelectionChange);

    document
        .getElementById('selectedTasks')
        .addEventListener('change', handleTaskSelectionChange);

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
        
        if (response.status === 401 || response.status === 403) {
            showAuthRequiredMessage();
            return null;
        }
        
        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
            let isAuthError = false;
            
            try {
                const errorData = await response.text();
                if (errorData) {
                    const parsedError = JSON.parse(errorData);
                    let errorText = '';
                    
                    if (parsedError.errorMessages && parsedError.errorMessages.length > 0) {
                        errorText = parsedError.errorMessages.join('\n');
                        errorMessage += '\n' + errorText;
                    } else if (parsedError.message) {
                        errorText = parsedError.message;
                        errorMessage += '\n' + errorText;
                    } else if (errorData.length < 500) {
                        errorText = errorData;
                        errorMessage += '\n' + errorText;
                    }
                    
                    // Проверяем, является ли это ошибкой авторизации
                    const authKeywords = [
                        'анонимных пользователей',
                        'anonymous',
                        'не существует, или не отображается',
                        'does not exist, or is not displayed',
                        'worklogAuthor',
                        'worklogDate',
                        'authentication',
                        'authorization',
                        'unauthorized',
                        'forbidden'
                    ];
                    
                    const lowerErrorText = errorText.toLowerCase();
                    isAuthError = authKeywords.some(keyword => lowerErrorText.includes(keyword.toLowerCase()));
                }
            } catch (parseError) {
                // Игнорируем ошибки парсинга, используем базовое сообщение
            }
            
            // Если это ошибка авторизации (400 с сообщением об анонимных пользователях), показываем сообщение об авторизации
            if (response.status === 400 && isAuthError) {
                showAuthRequiredMessage();
                return null;
            }
            
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        
        if (!data || !data.issues || !Array.isArray(data.issues)) {
            showAuthRequiredMessage();
            return null;
        }
        
        return data.issues.map(issue => issue.key);
    } catch (exception) {
        if (exception.message && (exception.message.includes('map') || exception.message.includes('Cannot read properties'))) {
            showAuthRequiredMessage();
        } else {
            showError('Ошибка загрузки: ' + exception.message);
        }
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
        
        if (response.status === 401 || response.status === 403) {
            showAuthRequiredMessage();
            return null;
        }
        
        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
            let isAuthError = false;
            
            try {
                const errorData = await response.text();
                if (errorData) {
                    const parsedError = JSON.parse(errorData);
                    let errorText = '';
                    
                    if (parsedError.errorMessages && parsedError.errorMessages.length > 0) {
                        errorText = parsedError.errorMessages.join('\n');
                        errorMessage += '\n' + errorText;
                    } else if (parsedError.message) {
                        errorText = parsedError.message;
                        errorMessage += '\n' + errorText;
                    } else if (errorData.length < 500) {
                        errorText = errorData;
                        errorMessage += '\n' + errorText;
                    }
                    
                    // Проверяем, является ли это ошибкой авторизации
                    const authKeywords = [
                        'анонимных пользователей',
                        'anonymous',
                        'не существует, или не отображается',
                        'does not exist, or is not displayed',
                        'worklogAuthor',
                        'worklogDate',
                        'authentication',
                        'authorization',
                        'unauthorized',
                        'forbidden'
                    ];
                    
                    const lowerErrorText = errorText.toLowerCase();
                    isAuthError = authKeywords.some(keyword => lowerErrorText.includes(keyword.toLowerCase()));
                }
            } catch (parseError) {
                // Игнорируем ошибки парсинга, используем базовое сообщение
            }
            
            // Если это ошибка авторизации (400 с сообщением об анонимных пользователях), показываем сообщение об авторизации
            if (response.status === 400 && isAuthError) {
                showAuthRequiredMessage();
                return null;
            }
            
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        
        if (!data || !data.worklogs) {
            return [];
        }
        
        return data.worklogs;
    } catch (exception) {
        if (exception.message && exception.message.includes('map')) {
            showAuthRequiredMessage();
        } else {
            console.error(`Ошибка загрузки worklogs для ${issueKey}:`, exception);
        }
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

    // Вычисляем итоги по дням, суммируя секунды для точности
    issues.forEach(issue => {
        for (let day = 1; day <= daysInMonth; day++) {
            const logs = localData[issue]?.[day] || [];
            const totalSeconds = logs.reduce((sum, worklog) => sum + worklog.seconds, 0);
            if (!totalsPerDay[day]) {
                totalsPerDay[day] = { seconds: 0 };
            }
            totalsPerDay[day].seconds += totalSeconds;
        }
    });
    
    // Конвертируем секунды в часы с округлением только финального результата
    for (let day = 1; day <= daysInMonth; day++) {
        if (totalsPerDay[day]) {
            totalsPerDay[day] = Math.round((totalsPerDay[day].seconds / 3600) * 100) / 100;
        } else {
            totalsPerDay[day] = 0;
        }
    }

    let html = '<table><thead><tr><th rowspan="2">Задача</th>';

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        html += `<th>${date.toLocaleDateString('ru-RU', {weekday: 'short'})}</th>`;
    }

    html += '</tr><tr>';

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        html += `<th>${day}</th>`;
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
function clearSelection() {
    document.querySelectorAll(".selected").forEach(cell => {
        cell.classList.remove("selected");
    });
    selectedTask = null;
    selectedDays.clear();
    isSelecting = false;
}

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

    document.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
            return;
        }

        const target = event.target;
        const isCell = target.closest("td[data-task]");

        if (!isCell) {
            clearSelection();
        }
    });

    document.addEventListener("mouseup", () => {
        isSelecting = false;
    });
}

// === Popup Logic ===
async function openPopup(task, days) {
    const hoursInput = prompt("Сколько часов поставить?", "8");
    if (hoursInput === null) {
        clearSelection();
        return;
    }

    const hours = parseFloat(hoursInput.trim());
    if (isNaN(hours) || hours < 0) {
        alert("Некорректное значение");
        clearSelection();
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

        if (!skipWeekends) {
            clearSelection();
            return;
        }

        if (skipWeekends) {
            sortedDays = sortedDays.filter(day => !weekendDays.includes(day));

            if (sortedDays.length === 0) {
                alert("После исключения выходных не осталось дней для заполнения.");
                clearSelection();
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
    const resultElement = document.getElementById('result');
    // Заменяем переносы строк на <br> для HTML отображения
    const htmlMessage = message.replace(/\n/g, '<br>');
    resultElement.innerHTML = `<div class="error-message">${htmlMessage}</div>`;
}

function showAuthRequiredMessage() {
    const jiraUrl = window.jiraData?.jiraUrl;
    let linkHtml = '';
    
    if (jiraUrl) {
        linkHtml = `<a href="${jiraUrl}" target="_blank" class="auth-link">Перейти в Jira для авторизации</a>`;
    } else {
        linkHtml = '<p class="auth-hint">Укажите URL Jira в настройках расширения.</p>';
    }
    
    const messageHtml = `
        <div class="auth-message">
            <div class="auth-message-content">
                <h3>⚠️ Требуется авторизация</h3>
                <p>Вы не авторизованы в Jira. Пожалуйста, авторизуйтесь для использования расширения.</p>
                ${linkHtml}
                <p class="auth-hint">После авторизации обновите страницу.</p>
            </div>
        </div>
    `;
    document.getElementById('result').innerHTML = messageHtml;
    hideProgress();
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

// === Auto Fill Functions ===
function toggleAutoFillPanel() {
    const panel = document.getElementById('autoFillPanel');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
    } else {
        panel.style.display = 'none';
    }
}

function hideAutoFillPanel() {
    document.getElementById('autoFillPanel').style.display = 'none';
}

function handleTaskSelectionChange(event) {
    const randomTasksCheckbox = document.getElementById('randomTasks');
    const selectedTasksCheckbox = document.getElementById('selectedTasks');
    const selectedTasksInputGroup = document.getElementById('selectedTasksInputGroup');
    const selectedTasksInput = document.getElementById('selectedTasksInput');
    
    // Если выбран чекбокс, который был изменён, снимаем другой
    if (event.target.id === 'randomTasks' && randomTasksCheckbox.checked) {
        selectedTasksCheckbox.checked = false;
        selectedTasksInputGroup.style.display = 'none';
        selectedTasksInput.disabled = true;
    } else if (event.target.id === 'selectedTasks' && selectedTasksCheckbox.checked) {
        randomTasksCheckbox.checked = false;
        selectedTasksInputGroup.style.display = 'block';
        selectedTasksInput.disabled = false;
    } else if (!selectedTasksCheckbox.checked) {
        selectedTasksInputGroup.style.display = 'none';
        selectedTasksInput.disabled = true;
    }
}

async function applyAutoFill() {
    const omniHoursText = document.getElementById('omniHours').value.trim();
    const randomTasksChecked = document.getElementById('randomTasks').checked;
    const selectedTasksChecked = document.getElementById('selectedTasks').checked;
    const selectedTasksInput = document.getElementById('selectedTasksInput').value.trim();
    
    // Парсим значение OMNI-1
    const omniHours = parseHoursFromText(omniHoursText);
    if (isNaN(omniHours) || omniHours < 0) {
        alert('Некорректное значение для OMNI-1. Используйте формат "1 час" или "1.5 час"');
        return;
    }
    
    // Получаем норму часов из настроек
    const norm = parseFloat(window.jiraData.normHours) || 8;
    
    // Получаем текущий месяц
    const [year, month] = monthSelector.value.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    
    // Определяем дни, в которых не хватает часов
    const daysWithInsufficientHours = findDaysWithInsufficientHours(year, month, daysInMonth, norm);
    
    if (daysWithInsufficientHours.length === 0) {
        alert('Все дни уже заполнены до нормы.');
        hideAutoFillPanel();
        return;
    }
    
    // Определяем список задач для распределения времени
    let tasksForDistribution = [];
    
    if (selectedTasksChecked && selectedTasksInput) {
        // Если выбрано "Ввести задачи вручную"
        tasksForDistribution = selectedTasksInput.split(',').map(task => task.trim()).filter(task => task.length > 0);
        
        // Исключаем OMNI-1 из списка задач для распределения
        tasksForDistribution = tasksForDistribution.filter(task => task !== 'OMNI-1');
        
        if (tasksForDistribution.length === 0) {
            alert('Не указаны задачи для распределения времени.');
            return;
        }
    } else if (randomTasksChecked) {
        // Если выбрано "Распределить время по всем задачам в этом месяце"
        // Исключаем OMNI-1 из списка задач для распределения
        tasksForDistribution = Object.keys(localData).filter(task => task !== 'OMNI-1');
        
        if (tasksForDistribution.length === 0) {
            alert('Не найдено задач в текущем месяце.');
            return;
        }
    }
    
    // Подтверждение перед выполнением
    const daysCount = daysWithInsufficientHours.length;
    const confirmMessage = `Будет обработано ${daysCount} ${daysCount === 1 ? 'день' : daysCount < 5 ? 'дня' : 'дней'}.\n\n` +
        `OMNI-1: ${omniHours} ${omniHours === 1 ? 'час' : 'часа'}\n` +
        `Задач для распределения: ${tasksForDistribution.length}\n\n` +
        `Продолжить?`;
    
    if (!confirm(confirmMessage)) {
        return;
    }
    
    showProgress('Автоматическое списание времени...');
    
    // Фильтруем дни, исключая выходные
    const workingDays = daysWithInsufficientHours.filter(day => {
        const date = new Date(year, month - 1, day);
        const dayOfWeek = date.getDay();
        return dayOfWeek !== 0 && dayOfWeek !== 6;
    });
    
    // Функция для обработки одного дня
    const processDay = async (day) => {
        try {
            // Вычисляем текущее количество часов в дне (до добавления OMNI-1)
            const currentHoursBeforeOmni = calculateTotalHoursForDay(day);
            const missingHoursBeforeOmni = norm - currentHoursBeforeOmni;
            
            if (missingHoursBeforeOmni <= 0) {
                return {day, success: true};
            }
            
            // 1. Добавляем время на OMNI-1
            if (omniHours > 0) {
                const currentOmniHours = calculateHoursForTaskAndDay('OMNI-1', day);
                // Устанавливаем время на OMNI-1 только если:
                // - времени нет (0) - устанавливаем из настройки
                // - текущее время меньше настройки - устанавливаем из настройки
                // Если уже установлено больше или равно настройке (вручную), не трогаем
                if (currentOmniHours === 0 || currentOmniHours < omniHours) {
                    await addWorklogForDay('OMNI-1', day, year, month, omniHours);
                }
            }
            
            // 2. Распределяем оставшееся время между задачами
            if (tasksForDistribution.length > 0) {
                // Вычисляем фактическое время на OMNI-1 после возможного добавления в секундах для точности
                const actualOmniSeconds = calculateSecondsForTaskAndDay('OMNI-1', day);
                
                // Вычисляем время для распределения между задачами в секундах
                const secondsForDistribution = (norm * 3600) - actualOmniSeconds;
                
                if (secondsForDistribution > 0) {
                    // Вычисляем текущее время на всех задачах для распределения в секундах (после добавления OMNI-1)
                    const taskCurrentSeconds = {};
                    let currentSecondsOnTasks = 0;
                    for (const task of tasksForDistribution) {
                        const seconds = calculateSecondsForTaskAndDay(task, day);
                        taskCurrentSeconds[task] = seconds;
                        currentSecondsOnTasks += seconds;
                    }
                    
                    // Вычисляем текущее общее время в дне в секундах (после добавления OMNI-1)
                    const currentTotalSecondsAfterOmni = actualOmniSeconds + currentSecondsOnTasks;
                    const targetTotalSeconds = norm * 3600;
                    const missingSecondsAfterOmni = targetTotalSeconds - currentTotalSecondsAfterOmni;
                    
                    if (missingSecondsAfterOmni > 0) {
                        // Вычисляем целевое время для распределения в секундах для точности
                        const secondsPerTask = Math.floor(secondsForDistribution / tasksForDistribution.length);
                        const remainderSeconds = secondsForDistribution % tasksForDistribution.length;
                        
                        // Вычисляем, сколько времени нужно добавить на задачи для достижения целевого значения
                        const secondsNeededForTarget = secondsForDistribution - currentSecondsOnTasks;
                        
                        // Если недостающее время меньше чем нужно для достижения целевого значения,
                        // то распределяем только недостающее время пропорционально
                        // Иначе устанавливаем целевое значение на всех задачах
                        const secondsToAddTotal = Math.min(missingSecondsAfterOmni, Math.max(0, secondsNeededForTarget));
                        
                        if (secondsToAddTotal > 0) {
                            // Распределяем недостающее время в секундах между задачами
                            const secondsToAddPerTask = Math.floor(secondsToAddTotal / tasksForDistribution.length);
                            const secondsRemainder = secondsToAddTotal % tasksForDistribution.length;
                            
                            // Обрабатываем задачи параллельно
                            const taskPromises = tasksForDistribution.map(async (task, index) => {
                                const currentTaskSeconds = taskCurrentSeconds[task];
                                
                                // Вычисляем целевое время для задачи в секундах
                                let targetSeconds;
                                if (secondsNeededForTarget <= missingSecondsAfterOmni) {
                                    // Если недостающего времени достаточно для достижения целевого значения,
                                    // устанавливаем целевое значение (с учетом остатка для последних задач)
                                    targetSeconds = secondsPerTask;
                                    // Распределяем остаток на последние задачи
                                    if (index >= tasksForDistribution.length - remainderSeconds) {
                                        targetSeconds += 1;
                                    }
                                } else {
                                    // Если недостающего времени меньше, добавляем пропорциональную долю
                                    targetSeconds = currentTaskSeconds + secondsToAddPerTask;
                                    // Распределяем остаток на последние задачи
                                    if (index >= tasksForDistribution.length - secondsRemainder) {
                                        targetSeconds += 1;
                                    }
                                }
                                
                                // Устанавливаем целевое время только если оно больше текущего
                                if (targetSeconds > currentTaskSeconds) {
                                    // Округляем секунды до целого числа для точности
                                    const roundedSeconds = Math.round(targetSeconds);
                                    const targetHours = roundedSeconds / 3600;
                                    await addWorklogForDay(task, day, year, month, targetHours);
                                }
                            });
                            
                            await Promise.all(taskPromises);
                        }
                    }
                }
            }
            
            return {day, success: true};
        } catch (error) {
            console.error(`Ошибка при обработке дня ${day}:`, error);
            return {day, success: false, error: error.message};
        }
    };
    
    // Обрабатываем все дни параллельно
    let completed = 0;
    const dayPromises = workingDays.map(async (day) => {
        const result = await processDay(day);
        completed++;
        updateProgress(completed, workingDays.length, `Обработано дней: ${completed} из ${workingDays.length}`);
        return result;
    });
    
    const results = await Promise.allSettled(dayPromises);
    
    // Собираем ошибки и считаем успешно обработанные дни
    const errors = [];
    let processed = 0;
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            if (result.value.success) {
                processed++;
            } else {
                errors.push(`День ${result.value.day}: ${result.value.error}`);
            }
        } else {
            errors.push(`День ${workingDays[index]}: ${result.reason?.message || 'Неизвестная ошибка'}`);
        }
    });
    
    hideProgress();
    
    if (errors.length > 0) {
        alert(`Ошибки при автоматическом списании:\n${errors.join('\n')}`);
    }
    
    // Перезагружаем данные
    await loadWorklogs();
    hideAutoFillPanel();
}

// Вспомогательная функция для парсинга часов из текста
function parseHoursFromText(text) {
    // Удаляем все нецифровые символы кроме точки и запятой
    const cleaned = text.replace(/[^\d.,]/g, '');
    // Заменяем запятую на точку
    const normalized = cleaned.replace(',', '.');
    return parseFloat(normalized);
}

// Функция для определения дней с недостаточным количеством часов
function findDaysWithInsufficientHours(year, month, daysInMonth, norm) {
    const days = [];
    const today = new Date();
    
    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        const dayOfWeek = date.getDay();
        
        // Пропускаем выходные
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            continue;
        }
        
        // Пропускаем будущие дни
        if (date > today) {
            continue;
        }
        
        const totalHours = calculateTotalHoursForDay(day);
        
        if (totalHours < norm) {
            days.push(day);
        }
    }
    
    return days;
}

// Функция для вычисления общего количества часов в дне
function calculateTotalHoursForDay(day) {
    let totalSeconds = 0;
    
    Object.keys(localData).forEach(issue => {
        const logs = localData[issue]?.[day] || [];
        totalSeconds += logs.reduce((sum, worklog) => sum + worklog.seconds, 0);
    });
    
    // Округляем только финальный результат, чтобы избежать накопления ошибок округления
    return Math.round((totalSeconds / 3600) * 100) / 100;
}

// Функция для вычисления часов для конкретной задачи в конкретный день
function calculateHoursForTaskAndDay(task, day) {
    const logs = localData[task]?.[day] || [];
    return calculateHours(logs);
}

// Функция для вычисления точного количества секунд для конкретной задачи в конкретный день
function calculateSecondsForTaskAndDay(task, day) {
    const logs = localData[task]?.[day] || [];
    return logs.reduce((sum, worklog) => sum + worklog.seconds, 0);
}

// Функция для добавления worklog для задачи в конкретный день
async function addWorklogForDay(task, day, year, month, hours) {
    if (hours <= 0) {
        return;
    }
    
    // Удаляем существующие worklogs для этой задачи в этот день
    const existingLogs = localData[task]?.[day] || [];
    
    for (const worklog of existingLogs) {
        try {
            const deleteResponse = await fetch(`${window.jiraData.jiraUrl}/rest/api/2/issue/${task}/worklog/${worklog.id}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            
            if (!deleteResponse.ok) {
                console.error(`Ошибка удаления worklog ${worklog.id}: ${deleteResponse.status} ${deleteResponse.statusText}`);
            }
        } catch (error) {
            console.error(`Ошибка при удалении worklog ${worklog.id}:`, error);
        }
    }
    
    // Создаем новый worklog
    const date = new Date(year, month - 1, day, 9, 0, 0);
    
    // Округляем секунды до целого числа для точности
    const seconds = Math.round(hours * 3600);
    
    try {
        const createResponse = await fetch(`${window.jiraData.jiraUrl}/rest/api/2/issue/${task}/worklog`, {
            method: 'POST',
            credentials: 'include',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                started: formatJiraDate(date),
                timeSpentSeconds: seconds
            })
        });
        
        if (!createResponse.ok) {
            const errorText = await createResponse.text();
            throw new Error(`HTTP ${createResponse.status}: ${errorText}`);
        }
        
        const createdWorklog = await createResponse.json();
        
        // Обновляем localData с точным количеством секунд
        localData[task] ??= {};
        localData[task][day] = [{
            id: createdWorklog.id,
            started: formatJiraDate(date),
            seconds: seconds,
            comment: ""
        }];
    } catch (error) {
        console.error(`Ошибка при создании worklog для ${task} в день ${day}:`, error);
        throw error;
    }
}