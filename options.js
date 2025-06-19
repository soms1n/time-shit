document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(['jiraUrl','username','taskFilter','normHours'], (data) => {
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

  chrome.storage.sync.set({ jiraUrl, username, taskFilter, normHours }, () => {
    document.getElementById('status').innerText = "Сохранено!";
  });
});