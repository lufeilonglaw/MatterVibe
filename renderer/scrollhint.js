// scrollhint.js —— 通用"下方还有内容"提示：滚动条全部隐藏后，
// 在可滚动容器底部以一枚淡淡的向下箭头提示，滚到底自动消失。

'use strict';

function attachScrollHint(el) {
  if (!el) return;
  let hint = el.querySelector(':scope > .scroll-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'scroll-hint';
    hint.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    el.addEventListener('scroll', () => updateScrollHint(el), { passive: true });
  }
  el.appendChild(hint); // 始终保持为最后一个子元素（sticky 底部）
  requestAnimationFrame(() => updateScrollHint(el));
}

function updateScrollHint(el) {
  const hint = el.querySelector(':scope > .scroll-hint');
  if (!hint) return;
  const more = el.scrollHeight - el.scrollTop - el.clientHeight > 14;
  hint.classList.toggle('gone', !more);
}

// 窗口尺寸变化时全量复查
window.addEventListener('resize', () => {
  document.querySelectorAll('.scroll-hint').forEach(h => updateScrollHint(h.parentElement));
});
