const { createApp } = require('./server/app');

const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`api listening on ${port}`));
