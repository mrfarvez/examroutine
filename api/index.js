const { createApp } = require('../app');

let cachedApp = null;

module.exports = async (req, res) => {
  if (!cachedApp) cachedApp = createApp();
  const app = await cachedApp;
  return app(req, res);
};
