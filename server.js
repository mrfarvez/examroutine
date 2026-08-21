require('dotenv').config();
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;

(async () => {
  const app = await createApp();
  app.listen(PORT, () => {
    console.log(`DIU Exam Schedule Finder running on http://localhost:${PORT}`);
  });
})().catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
