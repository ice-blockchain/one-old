export function renderCatalog(host, items) {
  if (!host) return;
  host.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('article');
      const heading = document.createElement('h2');
      heading.textContent = item.title;
      row.append(heading);
      return row;
    }),
  );
}
