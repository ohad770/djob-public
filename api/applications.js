const { handleCreateApplication } = require('../lib/public-core');

async function handler(req, res) {
  return handleCreateApplication(req, res);
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
