require('dotenv').config();
const { createApp } = require('../app');

let cachedApp = null;

module.exports = async (req, res) => {
  if (!cachedApp) {
    cachedApp = await createApp();
  }
  return cachedApp(req, res);
};
