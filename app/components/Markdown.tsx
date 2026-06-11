// Shared renderer for assistant markdown (app/lib/markdown.ts). Emits plain
// semantic HTML under .calderyn-md — deliberately framework-free (no Polaris)
// so the embedded slideout and the web dashboard both use it and style the
// wrapper in their own CSS.
import { useMemo } from "react";
import { parseMarkdown, type MdBlock, type MdInline } from "~/lib/markdown";

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text":
            return <span key={i}>{n.text}</span>;
          case "strong":
            return (
              <strong key={i}>
                <Inline nodes={n.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inline nodes={n.children} />
              </em>
            );
          case "code":
            return <code key={i}>{n.text}</code>;
          case "link":
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
                <Inline nodes={n.children} />
              </a>
            );
          default:
            // Unreachable (the switch is exhaustive); satisfies array-callback-return.
            return null;
        }
      })}
    </>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.type) {
    case "paragraph":
      return (
        <p>
          <Inline nodes={block.children} />
        </p>
      );
    case "heading": {
      // Chat headings never outrank the page's own h2/h3 hierarchy.
      const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
      return (
        <Tag>
          <Inline nodes={block.children} />
        </Tag>
      );
    }
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <Inline nodes={item} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
  }
}

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="calderyn-md">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}
