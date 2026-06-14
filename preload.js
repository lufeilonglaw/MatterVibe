// preload.js —— 通过 contextBridge 向渲染进程暴露受控的数据库 API

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  listMatters:   call('matters:list'),
  listArchivedMatters: call('matters:archivedList'),
  setMatterArchived: call('matters:archive'),
  getMatter:     call('matters:get'),
  createMatter:  call('matters:create'),
  cloneMatter:   call('matters:clone'),
  renameMatter:  call('matters:rename'),
  setMatterIcon: call('matters:icon'),
  setMatterRemind: call('matters:remind'),
  setMatterFolder: call('matters:folder'),
  chooseFolder:    call('folder:choose'),
  createFolderIn:  call('folder:createIn'),
  openFolder:      call('folder:open'),

  listLogs:   call('logs:list'),
  addLog:     call('logs:add'),
  deleteLog:  call('logs:delete'),
  listMails:  call('mails:list'),
  addMail:    call('mails:add'),
  deleteMail: call('mails:delete'),
  recordCounts:  call('records:counts'),
  listDeadlines: call('deadlines:list'),
  listEvents:  call('events:list'),
  addEvent:    call('events:add'),
  updateEvent: call('events:update'),
  setEventDone:call('events:done'),
  deleteEvent: call('events:delete'),
  getAgenda:   call('agenda:list'),
  getDashboard:call('dashboard:get'),
  demoState:  call('demo:state'),
  demoImport: call('demo:import'),
  demoClear:  call('demo:clear'),
  syncInfo:   call('sync:info'),
  cloudStatus: call('cloud:status'),
  cloudTest: call('cloud:test'),
  cloudSaveConfig: call('cloud:saveConfig'),
  cloudDisable: call('cloud:disable'),
  cloudSyncNow: call('cloud:syncNow'),
  cloudExportPassphrase: call('cloud:exportPassphrase'),
  syncExport: call('sync:export'),
  syncImport: call('sync:import'),

  backupRun:     call('backup:run'),
  backupList:    call('backup:list'),
  backupReveal:  call('backup:reveal'),
  backupRestore: call('backup:restore'),
  backupImport:  call('backup:import'),
  backupExport:  call('backup:export'),
  upgradeInfo:   call('upgrade:info'),
  upgradeAck:    call('upgrade:ack'),
  migrateResult: call('migrate:result'),
  migrateLegacyExists: call('migrate:legacyExists'),
  migrateRecoverNow:   call('migrate:recoverNow'),

  aiApiStatus: call('aiapi:status'),
  aiApiConfig: call('aiapi:config'),

  onChanged: (cb) => ipcRenderer.on('mf:changed', cb),
  onToolboxShow: (cb) => ipcRenderer.on('toolbox:show', cb),
  onMaxState: (cb) => ipcRenderer.on('window:maxState', (e, v) => cb(v)),
  updateCover:   call('matters:cover'),
  deleteMatter:  call('matters:delete'),

  addStage:      call('stages:add'),
  renameStage:   call('stages:rename'),
  deleteStage:   call('stages:delete'),

  addTask:       call('tasks:add'),
  updateTask:    call('tasks:update'),
  completeTask:  call('tasks:complete'),
  deleteTask:    call('tasks:delete'),
  moveTask:      call('tasks:move'),

  listTemplates: call('templates:list'),
  exportTemplate: call('template:export'),
  importTemplate: call('template:import'),
  saveTemplate:  call('templates:save'),
  resetTemplate: call('templates:reset'),
  newTemplate:   call('templates:new'),
  deleteTemplate: call('templates:delete'),
  backupTemplates: call('templates:backup'),
  listTemplateBackups: call('templates:backups'),
  restoreTemplateBackup: call('templates:restore'),

  getSetting: call('settings:get'),
  setSetting: call('settings:set'),

  backupData: call('data:backup'),

  openToolbox: call('toolbox:open'),

  winMinimize: call('window:minimize'),
  winMaximize: call('window:maximize'),
  winClose:    call('window:close')
});
