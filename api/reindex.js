module.exports = async function handler(req, res) {
  if (req.headers['x-reindex-key'] !== process.env.REINDEX_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  
  // Importe et déclenche la reconstruction de l'index
  const { buildIndex } = require('./chat');
  await buildIndex();
  
  res.json({ success: true, message: 'Index reconstruit avec succès' });
};
