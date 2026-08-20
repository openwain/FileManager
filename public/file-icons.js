(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LanternFileIcons = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GROUPS = [
    { kind: 'pdf', title: 'PDF 文档', extensions: ['pdf'] },
    { kind: 'document', title: '文本文档', extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf', 'pages', 'wps', 'wpd'] },
    { kind: 'spreadsheet', title: '电子表格', extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'numbers', 'csv', 'tsv'] },
    { kind: 'presentation', title: '演示文稿', extensions: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'odp', 'key'] },
    { kind: 'image', title: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'heif', 'avif', 'raw', 'psd', 'ai', 'eps'] },
    { kind: 'video', title: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'webm', 'm4v', 'flv', 'mpeg', 'mpg', '3gp', 'ts'] },
    { kind: 'audio', title: '音频', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'mid', 'midi'] },
    { kind: 'archive', title: '压缩包', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2', 'txz', 'zst', 'iso', 'dmg'] },
    { kind: 'code', title: '代码文件', extensions: ['html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf'] },
    { kind: 'data', title: '数据文件', extensions: ['json', 'jsonl', 'ndjson', 'parquet', 'avro', 'db', 'sqlite', 'sqlite3'] },
    { kind: 'text', title: '纯文本', extensions: ['txt', 'md', 'markdown', 'log', 'tex'] },
    { kind: 'font', title: '字体', extensions: ['ttf', 'otf', 'woff', 'woff2', 'eot'] },
    { kind: 'executable', title: '应用或安装包', extensions: ['exe', 'msi', 'apk', 'app', 'deb', 'rpm', 'jar', 'appx', 'msix'] },
    { kind: 'model', title: '设计或三维文件', extensions: ['obj', 'fbx', 'stl', 'gltf', 'glb', 'blend', '3ds', 'dwg', 'dxf', 'skp', 'fig', 'xd'] },
    { kind: 'ebook', title: '电子书', extensions: ['epub', 'mobi', 'azw', 'azw3', 'cbz', 'cbr'] },
    { kind: 'security', title: '证书或密钥', extensions: ['pem', 'crt', 'cer', 'key', 'pfx', 'p12'] },
    { kind: 'calendar', title: '日历或联系人', extensions: ['ics', 'vcf'] },
    { kind: 'email', title: '邮件', extensions: ['eml', 'msg'] },
    { kind: 'shortcut', title: '快捷方式', extensions: ['lnk', 'url', 'webloc'] }
  ];

  const EXTENSION_GROUP = new Map();
  GROUPS.forEach((group) => group.extensions.forEach((extension) => EXTENSION_GROUP.set(extension, group)));

  const COMPOUND_EXTENSIONS = [
    ['tar.gz', 'tgz'],
    ['tar.bz2', 'tbz2'],
    ['tar.xz', 'txz']
  ];

  const FORMAT_LABELS = {
    jpeg: 'JPG', markdown: 'MD', yaml: 'YAML', yml: 'YAML',
    sqlite: 'DB', sqlite3: 'DB', numbers: 'NUM', pages: 'PAGE',
    webloc: 'LINK', jsonl: 'JSON', ndjson: 'JSON', parquet: 'DATA'
  };

  function extensionFor(name) {
    const basename = String(name || '').split(/[\\/]/).pop().toLowerCase();
    const compound = COMPOUND_EXTENSIONS.find(([suffix]) => basename.endsWith(`.${suffix}`));
    if (compound) return compound[1];
    const lastDot = basename.lastIndexOf('.');
    return lastDot > 0 && lastDot < basename.length - 1 ? basename.slice(lastDot + 1) : '';
  }

  function describe(name, type = 'file') {
    if (type === 'folder') return { kind: 'folder', format: '', title: '文件夹' };
    const extension = extensionFor(name);
    const group = EXTENSION_GROUP.get(extension);
    const format = FORMAT_LABELS[extension] || (extension ? extension.toUpperCase().slice(0, 4) : 'FILE');
    return { kind: group?.kind || 'generic', format, title: group?.title || '文件' };
  }

  function iconMarkup(entry, escapeHtml = (value) => String(value)) {
    const descriptor = describe(entry?.name, entry?.type);
    if (descriptor.kind === 'folder') return '<span class="file-type folder" title="文件夹" aria-hidden="true"></span>';
    const title = `${descriptor.title} (${descriptor.format})`;
    return `<span class="file-type kind-${descriptor.kind}" title="${escapeHtml(title)}" aria-hidden="true"><span class="file-type-glyph"></span><b>${escapeHtml(descriptor.format)}</b></span>`;
  }

  return { describe, extensionFor, iconMarkup };
}));
