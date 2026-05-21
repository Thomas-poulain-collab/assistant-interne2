const { Client } = require('@notionhq/client');
const { Redis } = require('@upstash/redis');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const redis = Redis.fromEnv();

async function getBlocksRecursive(blockId) {
  let text = '';
  try {
    const blocks = await notion.blocks.children.list({ block_id: blockId, page_size: 100 });
    for (const block of blocks.results) {
      const type = block.type;
      const content = block[type];

      // Préfixe selon le type de bloc
      if (type === 'heading_1' && content?.rich_text) {
        text += '# ' + content.rich_text.map(t => t.plain_text).join('') + '\n';
      } else if (type === 'heading_2' && content?.rich_text) {
        text += '## ' + content.rich_text.map(t => t.plain_text).join('') + '\n';
      } else if (type === 'heading_3' && content?.rich_text) {
        text += '### ' + content.rich_text.map(t => t.plain_text).join('') + '\n';
      } else if (type === 'bulleted_list_item' && content?.rich_text) {
        text += '- ' + content.rich_text.map(t => t.plain_text).join('') + '\n';
      } else if (type === 'numbered_list_item' && content?.rich_text) {
        text += '• ' + content.rich_text.map(t => t.plain_text).join('') + '\n';
      } else if (content?.rich_text) {
        const blockText = content.rich_text.map(t => t.plain_text).join('');
        if (blockText) text += blockText + '\n';
      }

      // Récupère le contenu des sous-blocs
      if (block.has_children) {
        text += await getBlocksRecursive(block.id);
      }
    }
  } catch (e) {
    console.error('Block error:', e.message);
  }
  return text;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const key = req.headers['x-reindex-key'] || req.query.key;
  if (key !== process.env.REINDEX_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const pageId = process.env.NOTION_PAGE_SOURCE;
    if (!pageId) {
      return res.status(400).json({ error: 'NOTION_PAGE_SOURCE non défini' });
    }

    console.log('Lecture de la page source...');
    const content = await getBlocksRecursive(pageId);

    if (!content) {
      return res.status(400).json({ error: 'Page vide ou inaccessible' });
    }

    await redis.set('notion_source', content);

    return res.status(200).json({
      status: 'done',
      characters: content.length,
      preview: content.slice(0, 200)
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
