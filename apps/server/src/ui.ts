export function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface ErrorPageOpts {
  title: string
  message: string
  hint?: string
  action?: { label: string; href: string }
}

export function errorPage({ title, message, hint, action }: ErrorPageOpts): string {
  const hintBlock = hint
    ? `<div class="border-2 border-black p-4 bg-gray-50 mb-6">
      <p class="text-xs uppercase tracking-widest mb-1 font-bold">What to do</p>
      <p class="text-sm">${esc(hint)}</p>
    </div>`
    : ''

  const actionBlock = action
    ? `<a href="${esc(action.href)}" class="inline-block bg-black text-white font-bold text-sm px-6 py-3 border-2 border-black hover:bg-white hover:text-black no-underline">${esc(action.label)} →</a>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — github-issue-collab</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { border-radius: 0 !important; box-shadow: none !important; transition: none !important; }
    a { text-decoration: underline; }
    a:hover { background: #000; color: #fff; }
  </style>
</head>
<body class="bg-white text-black font-mono min-h-screen flex flex-col">
  <header class="border-b-4 border-black px-6 py-4">
    <a href="/" class="font-bold text-xl no-underline hover:bg-transparent hover:text-black">github-issue-collab</a>
  </header>
  <section class="border-b-4 border-black px-6 py-10 bg-black text-white">
    <p class="text-xs uppercase tracking-widest mb-3 text-red-400">Error</p>
    <h2 class="font-bold text-4xl mb-2">${esc(title)}</h2>
  </section>
  <main class="flex-1 px-6 py-10 max-w-2xl">
    <p class="text-base mb-6">${esc(message)}</p>
    ${hintBlock}
    ${actionBlock}
  </main>
  <footer class="border-t-2 border-black px-6 py-4 text-xs text-gray-500">
    github-issue-collab
  </footer>
</body>
</html>`
}
