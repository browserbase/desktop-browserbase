const { app } = require('electron');
globalThis.require = require;
app.setPath('userData', process.env.MIRROR_SMOKE_USER_DATA);
require('../dist/main/index.js');
