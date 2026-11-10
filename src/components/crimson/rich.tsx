export function Rich({ text }: { text: string }) {
  const chunks = text.split("```");
  return (
    <div className="space-y-2 text-sm leading-6">
      {chunks.map((chunk, index) => {
        if (index % 2 === 1) {
          const breakAt = chunk.indexOf("\n");
          const body = breakAt === -1 ? chunk : chunk.slice(breakAt + 1);
          return (
            <pre key={index} className="overflow-x-auto rounded-xl bg-bg p-3 font-mono text-xs leading-5 text-fg">
              {body.replace(/\n$/, "")}
            </pre>
          );
        }
        return chunk.split("\n").map((line, lineIndex) => (
          <p key={`${index}-${lineIndex}`} className="whitespace-pre-wrap">
            {renderInline(line) || " "}
          </p>
        ));
      })}
    </div>
  );
}

function renderInline(line: string) {
  const bits = line.split(/(\*\*[^*]+\*\*)/g);
  return bits.map((bit, index) => {
    if (bit.startsWith("**") && bit.endsWith("**")) {
      return (
        <strong key={index} className="font-semibold">
          {bit.slice(2, -2)}
        </strong>
      );
    }
    return <span key={index}>{bit}</span>;
  });
}
