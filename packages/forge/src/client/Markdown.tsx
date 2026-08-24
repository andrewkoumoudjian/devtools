import React from 'react';

function inline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link) {
      const href = link[2]!;
      const safe = href.startsWith('https://') || href.startsWith('http://') || href.startsWith('/') || href.startsWith('#');
      return safe ? <a key={index} href={href} rel="noreferrer">{link[1]}</a> : <span key={index}>{link[1]}</span>;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const nodes: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith('```')) body.push(lines[index++]!);
      index += 1;
      nodes.push(<pre key={`code-${index}`} className="forge-markdown-code"><code data-language={language || undefined}>{body.join('\n')}</code></pre>);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      nodes.push(<Tag key={`h-${index}`}>{inline(heading[2]!)}</Tag>);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!)) items.push(lines[index++]!.replace(/^[-*]\s+/, ''));
      nodes.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ul>);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index]!)) items.push(lines[index++]!.replace(/^\d+\.\s+/, ''));
      nodes.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ol>);
      continue;
    }

    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index]!.startsWith('> ')) quote.push(lines[index++]!.slice(2));
      nodes.push(<blockquote key={`q-${index}`}>{quote.map((value, quoteIndex) => <p key={quoteIndex}>{inline(value)}</p>)}</blockquote>);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,6})\s|^```|^[-*]\s+|^\d+\.\s+|^> /.test(lines[index]!)) paragraph.push(lines[index++]!);
    nodes.push(<p key={`p-${index}`}>{inline(paragraph.join(' '))}</p>);
  }

  return <article className="forge-markdown">{nodes}</article>;
}
