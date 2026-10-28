import { t, locale } from './i18n.js';

const normalized = value => value.toLocaleLowerCase(locale());
const order = (left, right) => left.localeCompare(right, locale(), { numeric: true, sensitivity: 'base' });

/** Shared disclosure list for single and multiple campaign selection.
 * Group identity comes from the API ID, never from a potentially repeated name.
 * Collapsed groups do not create thousands of unnecessary campaign controls. */
export function renderCampaignTree(container, { campaigns = [], term = '', expanded, selectedIds, multiple = false, maxSelected = 8, onSelect, onLayout = () => {} }) {
  const document = container.ownerDocument;
  const groups = new Map();
  for (const campaign of campaigns) {
    const knownGroup = typeof campaign.groupId === 'string' && campaign.groupId.length > 0;
    const key = campaign.groupId === null ? 'ungrouped' : knownGroup ? `group:${campaign.groupId}` : 'unknown';
    if (!groups.has(key)) groups.set(key, { key, id: knownGroup ? campaign.groupId : campaign.groupId === null ? '' : 'unknown', hasName: Boolean(knownGroup && campaign.groupName),
      name: campaign.groupId === null ? t('Без группы', 'No group') : knownGroup ? campaign.groupName || t(`Группа #${campaign.groupId}`, `Group #${campaign.groupId}`) : t('Группа не указана', 'Group not specified'), campaigns: [] });
    else if (knownGroup && campaign.groupName && !groups.get(key).hasName) { groups.get(key).name = campaign.groupName; groups.get(key).hasName = true; }
    groups.get(key).campaigns.push(campaign);
  }
  const search = normalized(term.trim());
  let matches = 0;
  container.replaceChildren();
  for (const group of [...groups.values()].sort((left, right) => order(left.name, right.name))) {
    const groupMatches = search && normalized(group.name).includes(search);
    const candidates = group.campaigns.filter(campaign => !search || groupMatches || normalized(`${campaign.name} ${campaign.id}`).includes(search));
    if (!candidates.length) continue;
    matches += candidates.length;
    const section = document.createElement('div'); section.className = 'campaign-group';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'campaign-group-toggle';
    toggle.dataset.groupId = group.id;
    const open = search ? !expanded.has(`closed:${group.key}`) : expanded.has(group.key);
    toggle.setAttribute('aria-expanded', String(open));
    const arrow = document.createElement('span'); arrow.className = 'campaign-group-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'campaign-group-name'; name.textContent = group.name;
    const count = document.createElement('small'); count.textContent = new Intl.NumberFormat(locale()).format(candidates.length);
    toggle.append(arrow, name, count); section.append(toggle);
    toggle.addEventListener('click', () => {
      const expansionKey = search ? `closed:${group.key}` : group.key;
      if (expanded.has(expansionKey)) expanded.delete(expansionKey); else expanded.add(expansionKey);
      renderCampaignTree(container, { campaigns, term, expanded, selectedIds, multiple, maxSelected, onSelect, onLayout });
      [...container.querySelectorAll('.campaign-group-toggle')].find(button => button.dataset.groupId === group.id)?.focus({ preventScroll: true });
    });
    if (open) {
      const list = document.createElement('div'); list.className = 'campaign-group-items'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', group.name);
      for (const campaign of candidates.sort((left, right) => order(left.name, right.name) || order(left.id, right.id))) {
        const option = document.createElement(multiple ? 'label' : 'button'); option.className = 'campaign-option'; option.dataset.campaignId = campaign.id;
        if (multiple) {
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = campaign.id;
          checkbox.checked = selectedIds.has(campaign.id); checkbox.disabled = !checkbox.checked && selectedIds.size >= maxSelected;
          checkbox.addEventListener('change', () => {
            onSelect(campaign.id, checkbox.checked);
            checkbox.checked = selectedIds.has(campaign.id);
            for (const input of container.querySelectorAll('input[type=checkbox]')) input.disabled = !input.checked && selectedIds.size >= maxSelected;
          });
          option.append(checkbox);
        } else {
          option.type = 'button'; option.setAttribute('aria-pressed', String(selectedIds.has(campaign.id)));
          option.addEventListener('click', () => onSelect(campaign.id));
        }
        const label = document.createElement('span'); label.textContent = campaign.name;
        const id = document.createElement('small'); id.textContent = `#${campaign.id}`;
        option.append(label, id); list.append(option);
      }
      section.append(list);
    }
    container.append(section);
  }
  onLayout();
  return matches;
}
