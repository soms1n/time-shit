/*
 * This file is part of Time Shit.
 *
 * Copyright (c) 2025 Somsin Dmitrii Aleksandrovich
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.sync.get(['jiraUrl', 'username', 'taskFilter', 'normHours'], (data) => {
        document.getElementById('jiraUrl').value = data.jiraUrl || "";
        document.getElementById('username').value = data.username || "";
        document.getElementById('taskFilter').value = data.taskFilter || "";
        document.getElementById('normHours').value = data.normHours || 8;
    });
});

document.getElementById('save').addEventListener('click', () => {
    const jiraUrl = document.getElementById('jiraUrl').value.trim();
    const username = document.getElementById('username').value.trim();
    const taskFilter = document.getElementById('taskFilter').value.trim();
    const normHours = parseFloat(document.getElementById('normHours').value) || 8;

    chrome.storage.sync.set({jiraUrl, username, taskFilter, normHours}, () => {
        document.getElementById('status').innerText = "Сохранено!";
    });
});