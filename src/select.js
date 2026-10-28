import { t, locale } from './i18n.js';

/** Local select-only comboboxes. Native selects remain the value/change source. */
export function enhanceSelects(root) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const controls = [];
  let opened = null;
  let disposed = false;
  const idPrefix = `bd-select-${Math.random().toString(36).slice(2, 10)}`;
  const arrow = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const check = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

  for (const [controlIndex, select] of [...root.querySelectorAll('select')].entries()) {
    if (select.matches('[data-query="campaignId"]')) continue;
    const id = `${idPrefix}-${controlIndex}`;
    const originalTabIndex = select.getAttribute('tabindex');
    const originalAriaHidden = select.getAttribute('aria-hidden');
    const wrap = document.createElement('span'); wrap.className = 'custom-select';
    wrap.dataset.selectFor = select.dataset.query || select.dataset.preference || String(controlIndex);
    select.before(wrap); wrap.append(select); select.classList.add('select-native');
    select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'select-trigger'; trigger.id = `${id}-trigger`;
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${id}-list`);
    const value = document.createElement('span'); value.className = 'select-value';
    const chevron = document.createElement('span'); chevron.className = 'select-chevron'; chevron.innerHTML = arrow;
    trigger.append(value, chevron);
    const menu = document.createElement('div'); menu.className = 'select-menu'; menu.id = `${id}-list`; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-labelledby', trigger.id); menu.hidden = true;
    const topLayer = typeof menu.showPopover === 'function';
    if (topLayer) menu.setAttribute('popover', 'manual');
    wrap.append(trigger, menu);
    let active = -1;
    let open = false;
    let optionNodes = [];
    let signature = '';
    let search = '';
    let searchTimer = null;
    const enabled = index => index >= 0 && index < select.options.length && !select.options[index].disabled && !select.options[index].hidden && !select.options[index].parentElement?.disabled;
    const enabledIndices = () => [...select.options].map((_, index) => index).filter(enabled);

    function close(restoreFocus = false) {
      if (!open) return;
      open = false;
      if (opened === api) opened = null;
      trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');
      if (topLayer && menu.matches(':popover-open')) menu.hidePopover();
      menu.hidden = true; delete menu.dataset.open;
      clearTimeout(searchTimer); search = '';
      if (restoreFocus && !trigger.disabled && !wrap.hidden) trigger.focus({ preventScroll: true });
    }
    function place() {
      if (!open) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = window.innerHeight;
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > viewportHeight || select.closest('[hidden]')) { close(); return; }
      const margin = 10, gap = 6;
      const width = Math.min(Math.max(rect.width, 238), 380, viewportWidth - margin * 2);
      menu.style.width = `${Math.max(0, width)}px`;
      menu.style.maxHeight = `${Math.min(328, viewportHeight - margin * 2)}px`;
      const desiredHeight = menu.getBoundingClientRect().height;
      const below = viewportHeight - margin - rect.bottom - gap;
      const above = rect.top - margin - gap;
      const flipped = below < desiredHeight && above > below;
      const available = flipped ? above : below;
      menu.style.maxHeight = `${Math.max(40, Math.min(328, available, viewportHeight - margin * 2))}px`;
      const height = menu.getBoundingClientRect().height;
      const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
      const preferredTop = flipped ? rect.top - gap - height : rect.bottom + gap;
      const top = Math.max(margin, Math.min(preferredTop, viewportHeight - height - margin));
      menu.style.left = `${left}px`; menu.style.top = `${top}px`;
      menu.dataset.placement = flipped ? 'above' : 'below';
    }
    function highlight(index, scroll = true) {
      if (!enabled(index)) return;
      active = index;
      for (const [optionIndex, element] of optionNodes.entries()) element?.classList.toggle('is-active', optionIndex === active);
      const element = optionNodes[active];
      if (element) {
        trigger.setAttribute('aria-activedescendant', element.id);
        if (scroll) {
          const top = element.offsetTop, bottom = top + element.offsetHeight;
          if (top < menu.scrollTop) menu.scrollTop = top;
          else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
        }
      }
    }
    function show(initialIndex) {
      if (disposed || trigger.disabled || wrap.hidden || select.closest('[hidden]')) return;
      if (opened && opened !== api) opened.close();
      sync();
      open = true; opened = api;
      menu.hidden = false; menu.dataset.open = 'true';
      if (topLayer && !menu.matches(':popover-open')) menu.showPopover();
      trigger.setAttribute('aria-expanded', 'true');
      place();
      const options = enabledIndices();
      highlight(enabled(initialIndex) ? initialIndex : enabled(select.selectedIndex) ? select.selectedIndex : options[0]);
      trigger.focus({ preventScroll: true });
    }
    function commit(index = active, restoreFocus = true) {
      if (!enabled(index)) { close(restoreFocus); return; }
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index;
      close(restoreFocus); sync();
      if (changed) {
        select.dispatchEvent(new window.Event('input', { bubbles: true }));
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    }
    function renderOptions() {
      menu.replaceChildren(); optionNodes = [];
      for (const [index, option] of [...select.options].entries()) {
        const element = document.createElement('div'); element.className = 'select-option'; element.id = `${id}-option-${index}`;
        element.setAttribute('role', 'option'); element.setAttribute('aria-selected', String(index === select.selectedIndex)); element.dataset.value = option.value;
        element.setAttribute('aria-disabled', String(!enabled(index))); element.hidden = option.hidden;
        if (option.title) element.title = option.title;
        const label = document.createElement('span'); label.className = 'select-option-label'; label.textContent = option.label;
        const mark = document.createElement('span'); mark.className = 'select-check'; mark.innerHTML = check;
        element.append(label, mark);
        element.addEventListener('pointerdown', event => event.preventDefault());
        element.addEventListener('pointermove', () => { if (open && enabled(index) && active !== index) highlight(index, false); });
        element.addEventListener('click', () => { if (enabled(index)) commit(index); });
        optionNodes[index] = element; menu.append(element);
      }
    }
    function sync() {
      if (disposed) return;
      wrap.hidden = select.hidden;
      trigger.disabled = select.disabled || !enabledIndices().length;
      trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.name || t('Выбор значения', 'Select value'));
      trigger.title = select.title || select.selectedOptions[0]?.label || '';
      value.textContent = select.selectedOptions[0]?.label || t('Выберите значение', 'Choose a value');
      const nextSignature = JSON.stringify([...select.options].map(option => [option.value, option.label, option.disabled, option.hidden, option.title, Boolean(option.parentElement?.disabled)]));
      if (nextSignature !== signature) { signature = nextSignature; renderOptions(); }
      for (const [index, element] of optionNodes.entries()) element.setAttribute('aria-selected', String(index === select.selectedIndex));
      if (open) {
        if (trigger.disabled || select.closest('[hidden]')) close();
        else { if (!enabled(active)) highlight(select.selectedIndex); place(); }
      }
    }
    function keydown(event) {
      if (trigger.disabled || event.ctrlKey || event.metaKey) return;
      const options = enabledIndices();
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') { if (open) commit(active, false); return; }
      if (event.altKey && event.key === 'ArrowUp') { if (open) { event.preventDefault(); close(true); } return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (!open) { show(event.key === 'Home' ? options[0] : event.key === 'End' ? options.at(-1) : select.selectedIndex); return; }
        const current = options.indexOf(active);
        const next = event.key === 'Home' ? options[0] : event.key === 'End' ? options.at(-1) : options[Math.max(0, Math.min(options.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))];
        highlight(next); return;
      }
      if (event.key === 'Enter' || (event.key === ' ' && !search)) { event.preventDefault(); if (open) commit(); else show(); return; }
      if (!event.altKey && event.key.length === 1) {
        event.preventDefault();
        if (!open) show();
        clearTimeout(searchTimer); search += event.key.toLocaleLowerCase(locale());
        const repeated = [...search].every(character => character === search[0]);
        const term = repeated ? search[0] : search;
        const start = Math.max(0, options.indexOf(active) + (repeated ? 1 : 0));
        const sequence = [...options.slice(start), ...options.slice(0, start)];
        const match = sequence.find(index => select.options[index].label.toLocaleLowerCase(locale()).startsWith(term));
        if (match !== undefined) highlight(match);
        searchTimer = setTimeout(() => { search = ''; }, 700);
      }
    }
    const onTriggerClick = () => { if (open) close(); else show(); };
    const onTriggerBlur = () => close();
    const onNativeFocus = () => trigger.focus({ preventScroll: true });
    trigger.addEventListener('click', onTriggerClick);
    trigger.addEventListener('keydown', keydown);
    trigger.addEventListener('blur', onTriggerBlur);
    select.addEventListener('change', sync);
    select.addEventListener('focus', onNativeFocus);
    const observer = new window.MutationObserver(sync);
    observer.observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
    const api = {
      close, place, sync, wrap, menu,
      destroy() {
        close(); observer.disconnect(); clearTimeout(searchTimer);
        trigger.removeEventListener('click', onTriggerClick); trigger.removeEventListener('keydown', keydown); trigger.removeEventListener('blur', onTriggerBlur);
        select.removeEventListener('change', sync); select.removeEventListener('focus', onNativeFocus);
        select.classList.remove('select-native');
        if (originalTabIndex === null) select.removeAttribute('tabindex'); else select.setAttribute('tabindex', originalTabIndex);
        if (originalAriaHidden === null) select.removeAttribute('aria-hidden'); else select.setAttribute('aria-hidden', originalAriaHidden);
        wrap.before(select); wrap.remove();
      },
    };
    controls.push(api); sync();
  }
  const onOutsidePointer = event => { if (opened && !event.composedPath().includes(opened.wrap) && !event.composedPath().includes(opened.menu)) opened.close(); };
  const onScroll = event => { if (opened && event.target !== opened.menu && !opened.menu.contains(event.target)) opened.place(); };
  const onResize = () => opened?.place();
  document.addEventListener('pointerdown', onOutsidePointer, true);
  document.addEventListener('scroll', onScroll, true);
  root.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('scroll', onResize);
  return {
    sync() { for (const control of controls) control.sync(); },
    close() { opened?.close(); },
    destroy() {
      if (disposed) return;
      for (const control of controls) control.destroy();
      disposed = true;
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      document.removeEventListener('scroll', onScroll, true); root.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    },
  };
}
