'use strict';
const $ = (id) => document.getElementById(id);
const { render } = window.ResearchUI;
$('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const symbol = $('symbol').value.trim().toUpperCase();
  if (!symbol) return;
  const q = new URLSearchParams({ symbol });
  if ($('peers').value.trim()) q.set('peers', $('peers').value.trim().toUpperCase());
  if ($('refresh').checked) q.set('refresh', '1');
  $('go').disabled = true;
  $('status').className = 'wrap status';
  $('status').textContent = 'Researching ' + symbol + '… this can take 10–40 seconds (several data sources, one request at a time).';
  try {
    const res = await fetch('/api/research?' + q);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
    render(body);
    $('status').textContent = 'Showing ' + body.symbol + '. Data is delayed / end-of-day; see dates in each section.';
    history.replaceState(null, '', '?symbol=' + encodeURIComponent(body.symbol));
  } catch (e) {
    $('status').className = 'wrap status error';
    $('status').textContent = 'Could not research ' + symbol + ': ' + e.message;
  } finally {
    $('go').disabled = false;
  }
});

const initial = new URLSearchParams(location.search).get('symbol');
if (initial) { $('symbol').value = initial; $('f').requestSubmit(); }
