// ─── Constants & Utilities ───────────────────────────────────────────────
// "const" creates a variable that can't be reassigned. Used here for values
// that never change during the app's life.

// The key under which we store all app data in localStorage (the browser's
// built-in key-value storage).
const STORAGE_KEY = 'p24crm';

// A tiny shortcut for document.querySelector — saves typing "$('#dlg')"
// instead of "document.querySelector('#dlg')" everywhere.
const $ = selector => document.querySelector(selector);

// Generates a short random string (e.g. "k3f9a2b") to use as a unique ID
// for new records. Math.random() gives a decimal like 0.1234..., .toString(36)
// turns it into base-36 text, and .slice(2, 9) takes 7 characters after "0.".
const uid = () => Math.random().toString(36).slice(2, 9);

// Are we running inside a Chrome extension? (Chrome sets chrome.runtime.id
// only in extensions, not on normal web pages.) The "!!" converts the result
// to a true/false boolean.
const EXT = !!(window.chrome && chrome.runtime && chrome.runtime.id);

// ─── State ───────────────────────────────────────────────────────────────
// "let" creates a variable that CAN be reassigned.
// db holds all app data: listings (properties), contacts (buyers), and wish
// (the shortlist — pairs of contact + listing the user has saved).
let db = { listings: [], contacts: [], wish: [] };

// Which tab is currently shown: 'listings' or 'contacts'.
let tab = 'listings';

// What the user typed into the search box.
let query = '';

// Listing IDs selected from the card grid for bulk actions.
let selectedListings = new Set();

// The listings layout currently shown in the main view.
let listingView = 'grid';

// The ordering used for the listings view.
let listingSort = 'newest';

// What the dialog (popup) is currently showing. null means "no dialog open".
// Shape: { t: 'l'|'c', id: <record id>, seg: 'm'|'w', fresh: 0|1 }
//   t    = type ('l' = listing, 'c' = contact)
//   id   = which record
//   seg  = which sub-tab inside the contact form ('m' = matches, 'w' = wishlist)
//   fresh = 1 if this is a brand-new unsaved contact (so we can discard it)
let context = null;

// Dialogs opened from a contact's match list can return to that contact.
let dialogHistory = [];

// ─── Persistence ─────────────────────────────────────────────────────────
// Read saved data from localStorage into "db".
const load = () => {
  try {
    // localStorage stores strings, so we parse the JSON back into an object.
    // The spread "..." merges the saved data over our defaults, so if a key
    // is missing in storage, the default (empty array) survives.
    db = { ...db, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch (e) {
    // If the stored JSON is corrupted, just keep the defaults.
  }
};

// Write "db" to localStorage and re-draw the screen.
const save = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  render();       // redraw the main list/grid
  fillDialog();   // refresh the dialog's contents (if one is open)
};

// ─── Formatting helpers ──────────────────────────────────────────────────
// Escape user-supplied text before injecting it into HTML, so a listing
// title containing "<script>" can't run code. This prevents XSS attacks.
const escapeHtml = s =>
  String(s ?? '').replace(/[&<>"]/g, c => (
    // Look up the HTML entity for each dangerous character.
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));

// Turn a number into a South African Rand string, e.g. 1500000 → "R 1 500 000".
// The regex inserts a space every 3 digits from the right.
const formatPrice = n =>
  n == null
    ? 'No price'
    : 'R ' + String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, ' ');

// Format editable money fields as South African Rand, e.g. "R 1 500 000".
// Values remain plain numbers in storage; only the input display is formatted.
const formatCurrencyInput = value => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? 'R ' + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '';
};
const currencyToNumber = value => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? Number(digits) : null;
};

// Format common South African phone numbers while preserving other numbers.
const formatPhone = value => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('27')) {
    const local = digits.slice(2, 11);
    return `+27 ${local.slice(0, 2)}${local.length > 2 ? ' ' + local.slice(2, 5) : ''}${local.length > 5 ? ' ' + local.slice(5) : ''}`.trim();
  }
  if (digits.startsWith('0')) {
    return `${digits.slice(0, 3)}${digits.length > 3 ? ' ' + digits.slice(3, 6) : ''}${digits.length > 6 ? ' ' + digits.slice(6, 10) : ''}`;
  }
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
};

// Turn "house, townhouse, flat" into ["house", "townhouse", "flat"].
const parseCsv = s =>
  (s || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);

// ─── Lookups ─────────────────────────────────────────────────────────────
// Find a record by ID. Returns undefined if not found.
const getListing = id => db.listings.find(x => x.id === id);
const getContact = id => db.contacts.find(x => x.id === id);

// Has this contact been shortlisted for this listing?
const isShortlisted = (contactId, listingId) =>
  db.wish.some(w => w.c === contactId && w.l === listingId);

// ─── Matching algorithm ──────────────────────────────────────────────────
// Scores how well a contact matches a listing. Returns 0–100.
// Weights only apply when BOTH sides have the relevant data, so a missing
// field doesn't unfairly penalise the score.
function scoreMatch(contact, listing) {
  let earned = 0; // points the listing earned
  let total = 0;  // maximum points it COULD have earned

  // Helper: add "weight" to the total, and to "earned" if condition is true.
  // If condition is null, skip entirely (data missing on one side).
  const add = (weight, condition) => {
    if (condition == null) return;
    total += weight;
    if (condition) earned += weight;
  };

  // Budget (40 pts): price must be within contact's range.
  // We allow a 5% over-budget tolerance (× 1.05) and 10% under-min (× 0.9).
  const hasBudget = (contact.min || contact.max) && listing.price != null;
  add(40, hasBudget
    ? (!contact.max || listing.price <= contact.max * 1.05) &&
      (!contact.min || listing.price >= contact.min * 0.9)
    : null);

  // Bedrooms (20 pts): listing must have at least the minimum.
  add(20, contact.beds && listing.beds != null
    ? listing.beds >= contact.beds
    : null);

  // Bathrooms (10 pts): same idea.
  add(10, contact.baths && listing.baths != null
    ? listing.baths >= contact.baths
    : null);

  // Suburbs (20 pts): any of the contact's suburbs must appear in the listing.
  const suburbs = parseCsv(contact.suburbs);
  add(20, suburbs.length
    ? suburbs.some(x => (listing.suburb || '').toLowerCase().includes(x))
    : null);

  // Property types (10 pts): same as suburbs, but for house/townhouse/etc.
  const types = parseCsv(contact.types);
  add(10, types.length
    ? types.some(x => (listing.type || '').toLowerCase().includes(x))
    : null);

  // If nothing could be scored (no data at all), return 0.
  return total ? Math.round(100 * earned / total) : 0;
}

// Find all contacts who score 60% or more for this listing, best first.
const matchesFor = listing =>
  db.contacts
    .map(contact => ({ contact, score: scoreMatch(contact, listing) }))
    .filter(x => x.score >= 60)
    .sort((a, b) => b.score - a.score);

// ─── Rendering ───────────────────────────────────────────────────────────
// Build the small "3 bed 2 bath 1 park" tag row for a listing card.
const renderSpecs = listing =>
  [
    listing.beds != null && listing.beds + ' bed',
    listing.baths != null && listing.baths + ' bath',
    listing.parking != null && listing.parking + ' park',
    listing.size != null && listing.size + ' m²',
  ].filter(Boolean).map(x => `<span>${x}</span>`).join('');

// Main redraw function — updates the counts, tabs, and the main area.
function render() {
  // Update the little counters in the nav ("12 listings", "5 contacts").
  $('#n-l').textContent = db.listings.length;
  $('#n-c').textContent = db.contacts.length;

  // Highlight the active tab.
  document.querySelectorAll('nav [data-tab]').forEach(btn =>
    btn.classList.toggle('on', btn.dataset.tab === tab)
  );

  // Pre-lowercase the search query once so we don't repeat it.
  const filter = query.toLowerCase();
  const main = $('main');

  // Draw whichever view is active.
  if (tab === 'listings') {
    renderListings(main, filter);
  } else {
    renderContacts(main, filter);
  }
}

// Draw the listing cards (or an empty-state message).
function renderListings(main, filter) {
  // Keep only listings whose searchable text contains the filter.
  const items = db.listings.filter(l =>
    !filter || [l.title, l.suburb, l.address, l.agent].join(' ').toLowerCase().includes(filter)
  );

  // If nothing to show, render an empty state.
  if (!items.length) {
    main.innerHTML = `<div class=empty><p>${
      db.listings.length ? 'No listings match that search.' : 'No listings yet.'
    }</p><button class=pri data-act=imp>Import listings</button></div>`;
    return;
  }

  const selectedVisible = items.filter(listing => selectedListings.has(listing.id)).length;
  const allVisibleSelected = items.length > 0 && selectedVisible === items.length;
  const sortedItems = [...items].sort((a, b) => {
    const ascendingPrice = (item, fallback) => item.price != null && Number.isFinite(Number(item.price)) ? Number(item.price) : fallback;
    if (listingSort === 'price-low') return ascendingPrice(a, Infinity) - ascendingPrice(b, Infinity);
    if (listingSort === 'price-high') return ascendingPrice(b, -Infinity) - ascendingPrice(a, -Infinity);
    if (listingSort === 'matches') return matchesFor(b).length - matchesFor(a).length;
    if (listingSort === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
    if (listingSort === 'oldest') return Number(a.added || 0) - Number(b.added || 0);
    return Number(b.added || 0) - Number(a.added || 0);
  });

  // Build one <article class=card> per listing and join them into a grid.
  main.innerHTML = `<div class=bulkbar>
    <label><input type=checkbox data-act=selectAll ${allVisibleSelected ? 'checked' : ''}> Select all visible</label>
    <span>${selectedListings.size ? `${selectedListings.size} selected` : ''}</span>
    <div class=view-switch aria-label="Listings layout">
      <button data-act=setListingView data-view=grid aria-pressed="${listingView === 'grid'}">Grid</button>
      <button data-act=setListingView data-view=list aria-pressed="${listingView === 'list'}">List</button>
    </div>
    <label class=sort-control>Sort
      <select id=listing-sort aria-label="Sort listings">
        <option value=newest ${listingSort === 'newest' ? 'selected' : ''}>Newest</option>
        <option value=oldest ${listingSort === 'oldest' ? 'selected' : ''}>Oldest</option>
        <option value=price-low ${listingSort === 'price-low' ? 'selected' : ''}>Price: low to high</option>
        <option value=price-high ${listingSort === 'price-high' ? 'selected' : ''}>Price: high to low</option>
        <option value=matches ${listingSort === 'matches' ? 'selected' : ''}>Most matches</option>
        <option value=title ${listingSort === 'title' ? 'selected' : ''}>Title: A to Z</option>
      </select>
    </label>
    <button class=dng data-act=delSelected ${selectedListings.size ? '' : 'disabled'}>Delete selected</button>
  </div><div class="grid ${listingView === 'list' ? 'list-view' : ''}">${sortedItems.map(listing => `
    <article class=card data-act=openL data-id="${escapeHtml(listing.id)}">
      <div class=card-actions>
        <label class=select-card aria-label="Select ${escapeHtml(listing.title)}"><input type=checkbox data-act=selectL data-id="${escapeHtml(listing.id)}" ${selectedListings.has(listing.id) ? 'checked' : ''}></label>
        <button data-act=editL data-id="${escapeHtml(listing.id)}">Edit</button>
        <button class=dng data-act=delCardL data-id="${escapeHtml(listing.id)}">Delete</button>
      </div>
      <div class=ph>${listing.img ? `<img loading=lazy src="${escapeHtml(listing.img)}" alt="">` : ''}</div>
      <div class=cb>
        <b>${formatPrice(listing.price)}</b>
        <div>${escapeHtml(listing.title)}</div>
        <small>${escapeHtml(listing.suburb)}</small>
        <div class=sp>${renderSpecs(listing)}</div>
        <div class=ft>
          <span>${matchesFor(listing).length} matches</span>
          <span>${db.wish.filter(w => w.l === listing.id).length} shortlisted</span>
        </div>
      </div>
    </article>`).join('')}</div>`;
}

// Draw the contacts table (or an empty-state message).
function renderContacts(main, filter) {
  const items = db.contacts.filter(c =>
    !filter || [c.name, c.email, c.phone, c.suburbs].join(' ').toLowerCase().includes(filter)
  );

  if (!items.length) {
    main.innerHTML = `<div class=empty><p>No contacts yet.</p><button class=pri data-act=newC>Add contact</button></div>`;
    return;
  }

  // Note: the <td> tags are intentionally left unclosed — HTML tolerates this.
  main.innerHTML = `<table><thead><tr><th>Name<th>Contact<th>Looking for<th>Matches<th>Shortlist</thead><tbody>${
    items.map(c => `
      <tr data-act=openC data-id="${c.id}">
        <td><b>${escapeHtml(c.name)}</b>
        <td>${escapeHtml(formatPhone(c.phone))}<br><small>${escapeHtml(c.email)}</small>
        <td>${c.min || c.max ? formatPrice(c.min || 0) + ' to ' + (c.max ? formatPrice(c.max) : 'any') : 'Any budget'}${
          c.beds ? ', ' + c.beds + '+ bed' : ''
        }<br><small>${escapeHtml(c.suburbs)}</small>
        <td>${db.listings.filter(l => scoreMatch(c, l) >= 60).length}
        <td>${db.wish.filter(w => w.c === c.id).length}
    `).join('')}</tbody></table>`;
}

// ─── Dialog ──────────────────────────────────────────────────────────────
// The dialog is an HTML <dialog> element (a native modal).
const dialog = $('#dlg');

// Replace the dialog's body with new HTML and open it if it isn't already.
const openDialog = html => {
  $('#dc').innerHTML = html;
  if (!dialog.open) dialog.showModal(); // showModal() = modal + backdrop
};

// Build one row inside the dialog: "Name … score% [Shortlist]".
// Works for both contact→listing and listing→contact rows.
const renderRow = (contact, listing, score) => {
  // "The OTHER side" — whichever record wasn't passed in comes from context.
  const contactId = contact ? contact.id : context.id;
  const listingId = listing ? listing.id : context.id;
  const shortlisted = isShortlisted(contactId, listingId);

  const thumbnail = listing
    ? (listing.img
      ? `<img class=property-thumb src="${escapeHtml(listing.img)}" alt="">`
      : '<span class="property-thumb property-thumb--empty" aria-hidden="true">⌂</span>')
    : '';
  const isPeeked = listing && context?.peekListingId === listing.id;
  const preview = listing && isPeeked ? `
    <div class=listing-peek>
      <div class=sp>${renderSpecs(listing)}</div>
      ${listing.address ? `<small>${escapeHtml(listing.address)}</small>` : ''}
      ${listing.desc ? `<p>${escapeHtml(listing.desc)}</p>` : '<p class=mut>No description available.</p>'}
    </div>` : '';

  return `<div class="match-item${isPeeked ? ' is-peeked' : ''}"><div class="r${listing ? ' listing-row' : ''}"${listing ? ` data-act=openL data-id="${escapeHtml(listing.id)}" data-return-context=contact tabindex=0 role=button` : ''}>
      ${thumbnail}
      <div class=row-copy>
        <b>${escapeHtml(contact ? contact.name : listing.title)}</b>
        <small>${contact
          ? escapeHtml(contact.phone ? formatPhone(contact.phone) : contact.email)
          : escapeHtml(listing.suburb) + ', ' + formatPrice(listing.price)}</small>
      </div>
      ${score != null ? `<span class=sc>${score}%</span>` : ''}
      ${listing ? `<div class=listing-row-actions><button data-act=peekL data-id="${escapeHtml(listing.id)}" aria-expanded="${isPeeked}">${isPeeked ? 'Hide' : 'Peek'}</button></div>` : ''}
      <button class="${shortlisted ? 'on' : ''}" data-act=toggle data-c="${contactId}" data-l="${listingId}">
        ${shortlisted ? 'Shortlisted' : 'Shortlist'}
      </button>
    </div>${preview}</div>`;
};

// Refresh the dialog's list section (#lst) based on what's open.
function fillDialog() {
  const listEl = $('#lst');
  // Bail out if: the list section doesn't exist, the dialog isn't open,
  // or we don't know what to show.
  if (!listEl || !dialog.open || !context) return;

  if (context.t === 'l') {
    fillListingDialog(listEl); // listing open → show matching contacts
  } else {
    fillContactDialog(listEl); // contact open → show matching listings
  }
}

// Listing dialog: show all contacts (best matches first).
function fillListingDialog(listEl) {
  const listing = getListing(context.id);
  if (!listing) return;

  listEl.innerHTML = db.contacts.length
    ? db.contacts
        .map(contact => ({ contact, score: scoreMatch(contact, listing) }))
        .sort((a, b) => b.score - a.score) // highest score first
        .map(x => renderRow(x.contact, null, x.score))
        .join('')
    : '<p class=mut>Add contacts to match them to this listing.</p>';
}

// Contact dialog: show either matches (score ≥ 60) or the shortlist.
function fillContactDialog(listEl) {
  const contact = getContact(context.id);
  if (!contact) return;

  const listings = context.seg === 'w'
    // Wishlist view: just the shortlisted listings.
    ? db.listings.filter(l => isShortlisted(contact.id, l.id))
    // Matches view: all listings scoring ≥ 60, best first.
    : db.listings
        .map(l => ({ listing: l, score: scoreMatch(contact, l) }))
        .filter(x => x.score >= 60)
        .sort((a, b) => b.score - a.score)
        .map(x => x.listing);

  listEl.innerHTML = listings.length
    ? listings.map(l =>
        renderRow(null, l, context.seg === 'w' ? null : scoreMatch(contact, l))
      ).join('')
    : `<p class=mut>${
        context.seg === 'w'
          ? 'Nothing shortlisted yet.'
          : 'No matches. Set a budget, bedrooms or suburbs above.'
      }</p>`;

  // Highlight the "Matches" / "Shortlist" sub-tab that's active.
  document.querySelectorAll('.seg button').forEach(btn =>
    btn.classList.toggle('on', btn.dataset.s === context.seg)
  );
}

// Remove listings and all shortlist entries that reference them.
function removeListings(ids) {
  const toRemove = new Set(ids);
  db.listings = db.listings.filter(listing => !toRemove.has(listing.id));
  db.wish = db.wish.filter(item => !toRemove.has(item.l));
  ids.forEach(id => selectedListings.delete(id));
  save();
}

// Build and show the listing editor used by the card's Edit button.
function renderListingForm(listing) {
  const val = key => escapeHtml(listing[key] ?? '');
  const money = key => escapeHtml(formatCurrencyInput(listing[key]));
  openDialog(`
    <div class=dh><h2>Edit listing</h2><button data-act=x aria-label=Close>×</button></div>
    <form id=lf onsubmit="return false" class=fg>
      <label class=w2>Title<input name=title value="${val('title')}" required></label>
      <label>Price<input name=price type=text inputmode=numeric data-format=currency value="${money('price')}" placeholder="R 0"></label>
      <label>Property type<input name=type value="${val('type')}"></label>
      <label>Bedrooms<input name=beds type=number min=0 value="${val('beds')}"></label>
      <label>Bathrooms<input name=baths type=number min=0 step=.5 value="${val('baths')}"></label>
      <label>Parking<input name=parking type=number min=0 value="${val('parking')}"></label>
      <label>Size (m²)<input name=size type=number min=0 value="${val('size')}"></label>
      <label>Suburb<input name=suburb value="${val('suburb')}"></label>
      <label>Address<input name=address value="${val('address')}"></label>
      <label class=w2>Image URL<input name=img type=url value="${val('img')}"></label>
      <label class=w2>Listing URL<input name=url type=url value="${val('url')}"></label>
      <label>Agent<input name=agent value="${val('agent')}"></label>
      <label class=w2>Description<textarea name=desc rows=3>${val('desc')}</textarea></label>
    </form>
    <div class=ar><button class=dng data-act=delL>Delete listing</button><button class=pri data-act=saveL>Save changes</button></div>
  `);
}

function restorePreviousDialog() {
  const previous = dialogHistory.pop();
  if (!previous) return false;
  const contact = previous.t === 'c' && getContact(previous.id);
  if (!contact) return false;
  context = previous;
  renderContactForm(contact);
  return true;
}

function closeDialog() {
  if (!restorePreviousDialog()) dialog.close();
}

// ─── Action handlers ─────────────────────────────────────────────────────
// One object holding every user action. When the user clicks something with
// data-act="foo", we call actions.foo(element.dataset). This keeps all click
// handling in one place.
const actions = {
  // Switch main tab.
  tab: d => {
    tab = d.tab;
    render();
  },

  // Open a listing in the dialog.
  openL: d => {
    const listing = getListing(d.id);
    if (!listing) return;
    if (d.returnContext === 'contact' && context?.t === 'c') {
      dialogHistory.push({ ...context });
    } else {
      dialogHistory = [];
    }
    context = { t: 'l', id: d.id };
    openDialog(`
      <div class=dh><h2>${formatPrice(listing.price)}</h2><button data-act=x aria-label=Close>×</button></div>
      ${listing.img ? `<img class=hero src="${escapeHtml(listing.img)}" alt="">` : ''}
      <p><b>${escapeHtml(listing.title)}</b><br>${
        escapeHtml([listing.address, listing.suburb].filter(Boolean).join(', '))
      }</p>
      <div class=sp>${renderSpecs(listing)}</div>
      <p class=mut>${escapeHtml(listing.desc)}</p>
      <p><a href="${escapeHtml(listing.url)}" target=_blank rel=noopener>Open on Property24</a>${
        listing.agent ? ' by ' + escapeHtml(listing.agent) : ''
      }</p>
      <h3>Contacts</h3>
      <div id=lst></div>
      <div class=ar><button class=dng data-act=delL>Remove listing</button></div>
    `);
    fillDialog();
  },

  // Edit a listing directly from its card.
  editL: d => {
    const listing = getListing(d.id);
    if (!listing) return;
    context = { t: 'e', id: listing.id };
    renderListingForm(listing);
  },

  // Select one listing for a bulk action.
  selectL: d => {
    if (d.id && selectedListings.has(d.id)) selectedListings.delete(d.id);
    else if (d.id) selectedListings.add(d.id);
    render();
  },

  // Select or deselect every listing currently visible after filtering.
  selectAll: () => {
    const visible = db.listings.filter(l => !query || [l.title, l.suburb, l.address, l.agent].join(' ').toLowerCase().includes(query.toLowerCase()));
    const everyVisibleSelected = visible.length && visible.every(l => selectedListings.has(l.id));
    visible.forEach(l => everyVisibleSelected ? selectedListings.delete(l.id) : selectedListings.add(l.id));
    render();
  },

  // Switch between compact cards and a full-width listing layout.
  setListingView: d => {
    listingView = d.view === 'list' ? 'list' : 'grid';
    render();
  },

  setListingSort: value => {
    listingSort = value;
    render();
  },

  // Delete a listing from its card.
  delCardL: d => {
    if (!getListing(d.id) || !confirm('Remove this listing?')) return;
    removeListings([d.id]);
  },

  // Delete all selected listings and their shortlist links in one action.
  delSelected: () => {
    const ids = [...selectedListings];
    if (!ids.length || !confirm(`Remove ${ids.length} selected listing${ids.length === 1 ? '' : 's'}?`)) return;
    removeListings(ids);
  },

  // Open an existing contact in the form.
  openC: d => {
    const contact = getContact(d.id);
    context = { t: 'c', id: contact.id, seg: 'm' };
    renderContactForm(contact);
  },

  // Create a brand-new blank contact and open the form.
  // "fresh: 1" marks it so we can delete it if the user closes without saving.
  newC: () => {
    const contact = { id: uid(), name: '' };
    db.contacts.push(contact);
    context = { t: 'c', id: contact.id, seg: 'm', fresh: 1 };
    renderContactForm(contact);
  },

  // Switch between "Matches" and "Shortlist" sub-tabs.
  seg: d => {
    context.seg = d.s;
    context.peekListingId = null;
    fillDialog();
  },

  // Expand or collapse a compact property summary in a contact's match list.
  peekL: d => {
    context.peekListingId = context.peekListingId === d.id ? null : d.id;
    fillDialog();
  },

  // Add/remove a shortlist entry.
  toggle: d => {
    const idx = db.wish.findIndex(w => w.c === d.c && w.l === d.l);
    if (idx < 0) db.wish.push({ c: d.c, l: d.l });  // add
    else db.wish.splice(idx, 1);                    // remove
    save();
  },

  // Save the contact form back to db.
  saveC: () => {
    const contact = getContact(context.id);
    const formData = new FormData($('#cf')); // FormData grabs all <input>s by name

    // Iterate over every [name, value] pair from the form.
    for (const [key, value] of formData) {
      // Numeric fields become numbers (or null if blank).
      contact[key] = ['min', 'max', 'beds', 'baths'].includes(key)
        ? (value === '' ? null : ['min', 'max'].includes(key) ? currencyToNumber(value) : +value)
        : key === 'phone' ? formatPhone(value) : value.trim();
    }

    // Name is required — if empty, focus the name input and stop.
    if (!contact.name) return $('#cf [name=name]').focus();

    context.fresh = 0; // mark as saved so close doesn't delete it
    save();
    dialog.close();
  },

  // Delete the current contact (plus their shortlist entries).
  delC: () => {
    if (!confirm('Delete this contact?')) return; // native yes/no prompt
    db.contacts = db.contacts.filter(c => c.id !== context.id);
    db.wish = db.wish.filter(w => w.c !== context.id);
    context.fresh = 0; // prevent the close handler from re-deleting
    save();
    dialog.close();
  },

  // Delete the current listing (plus any shortlist entries pointing to it).
  delL: () => {
    if (!confirm('Remove this listing?')) return;
    removeListings([context.id]);
    closeDialog();
  },

  // Save changes made in the listing form.
  saveL: () => {
    const listing = getListing(context.id);
    const form = $('#lf');
    if (!listing || !form.reportValidity()) return;
    for (const [key, value] of new FormData(form)) {
      listing[key] = ['price', 'beds', 'baths', 'parking', 'size'].includes(key)
        ? (value === '' ? null : key === 'price' ? currencyToNumber(value) : Number(value))
        : value.trim();
    }
    save();
    dialog.close();
  },

  // Close the dialog.
  x: () => closeDialog(),

  // Show the "Import listings" dialog.
  imp: () => {
    context = null; // no specific record open
    dialogHistory = [];
    openDialog(`
      <div class=dh><h2>Import listings</h2><button data-act=x aria-label=Close>×</button></div>
      <p class=mut>Paste Property24 URLs (listing or search pages), one per line. You can also paste page source or choose a saved .html page.${
        EXT ? '' : ' Fetching URLs only works from the browser extension; here, use page source or a saved page.'
      }</p>
      <textarea id=src rows=7 placeholder="https://www.property24.com/for-sale/..."></textarea>
      <div class=ar><input type=file id=fi accept=.html,.htm><button class=pri data-act=run>Import</button></div>
      <div id=log class=mut></div>
    `);
  },

  // Actually perform the import: from file, pasted HTML, or URLs.
  run: async () => {
    const input = $('#src').value.trim();
    const log = $('#log'); // the little status line
    let imported = 0;      // count of listings processed

    // Merge a batch of extracted listings into db (replace or insert).
    const addListings = newListings => {
      newListings.forEach(listing => {
        const idx = db.listings.findIndex(x => x.id === listing.id);
        if (idx < 0) {
          // Not seen before → add to the top (unshift = push to front).
          db.listings.unshift({ ...listing, added: Date.now() });
        } else {
          // Already exists → merge only non-empty fields over the old record.
          db.listings[idx] = {
            ...db.listings[idx],
            ...Object.fromEntries(
              Object.entries(listing).filter(([, v]) => v != null && v !== '')
            ),
          };
        }
        imported++;
      });
    };

    // Parse HTML text into a Document, then run our P24 extractor on it.
    const parse = (html, base) =>
      P24.extract(new DOMParser().parseFromString(html, 'text/html'), base);

    // 1. Uploaded file
    const file = $('#fi').files[0];
    if (file) {
      addListings(parse(await file.text(), 'https://www.property24.com/'));
    }

    // 2. Pasted HTML (looks like markup rather than URLs)
    if (/<html|<body|<div/i.test(input)) {
      addListings(parse(input, 'https://www.property24.com/'));
    }
    // 3. Pasted URLs — fetch each one and parse the response.
    else {
      const urls = input.split(/\s+/).filter(x => /^https?:\/\//.test(x));
      for (const url of urls) {
        log.textContent = 'Fetching ' + url + ' …';
        try {
          const res = await fetch(url, { credentials: 'omit' });
          if (!res.ok) throw Error(res.status);
          const found = parse(await res.text(), url);
          if (found.length) addListings(found);
          else log.textContent = 'Nothing found at ' + url;
        } catch (e) {
          // CORS or network error — tell the user to paste source instead.
          log.textContent = 'Could not fetch ' + url + '. Use the extension, or paste the page source instead.';
          save();
          return;
        }
      }
    }

    save();
    log.textContent = imported
      ? `Imported ${imported} listing${imported > 1 ? 's' : ''}.`
      : 'Nothing to import.';
  },
};

// ─── Contact form ────────────────────────────────────────────────────────
// Build and show the contact editing form.
function renderContactForm(contact) {
  // Small helper: read a field and HTML-escape it for safe use in value="…".
  const val = key => escapeHtml(contact[key] ?? '');
  const money = key => escapeHtml(formatCurrencyInput(contact[key]));

  openDialog(`
    <div class=dh>
      <h2>${contact.name ? escapeHtml(contact.name) : 'New contact'}</h2>
      <button data-act=x aria-label=Close>×</button>
    </div>
    <form id=cf onsubmit="return false" class=fg>
      <label>Name<input name=name value="${val('name')}" required></label>
      <label>Phone<input name=phone type=tel inputmode=tel data-format=phone value="${escapeHtml(formatPhone(contact.phone))}"></label>
      <label class=w2>Email<input name=email type=email value="${val('email')}"></label>
      <label>Min budget<input name=min type=text inputmode=numeric data-format=currency value="${money('min')}" placeholder="R 0"></label>
      <label>Max budget<input name=max type=text inputmode=numeric data-format=currency value="${money('max')}" placeholder="R 0"></label>
      <label>Bedrooms (min)<input name=beds type=number min=0 value="${val('beds')}"></label>
      <label>Bathrooms (min)<input name=baths type=number min=0 step=.5 value="${val('baths')}"></label>
      <label class=w2>Suburbs, comma separated<input name=suburbs value="${val('suburbs')}"></label>
      <label class=w2>Property types, e.g. house, townhouse<input name=types value="${val('types')}"></label>
      <label class=w2>Notes<textarea name=notes rows=2>${val('notes')}</textarea></label>
    </form>
    <div class=ar>
      <button class=dng data-act=delC>Delete</button>
      <button class=pri data-act=saveC>Save contact</button>
    </div>
    <div class=seg>
      <button data-act=seg data-s=m>Matches</button>
      <button data-act=seg data-s=w>Shortlist</button>
    </div>
    <div id=lst></div>
  `);
  fillDialog();
}

// ─── Event wiring ────────────────────────────────────────────────────────
// ONE click listener for the whole page. Any element with data-act (action)
// or data-tab (tab switch) is handled here — no per-button listeners needed.
document.addEventListener('click', e => {
  // .closest() walks up from the clicked element to find the nearest
  // element that has data-act or data-tab. If nothing matches, ignore.
  // A click on the empty area around a card control should not open the card.
  if (e.target.closest('.card-actions') && !e.target.closest('.card-actions [data-act]')) return;
  const target = e.target.closest('[data-act],[data-tab]');
  if (!target) return;

  if (target.dataset.tab) return actions.tab(target.dataset);
  // "?." = optional chaining: only call if the action exists.
  actions[target.dataset.act]?.(target.dataset);
});

// Make a focused property row open with Enter or Space, like a listing card.
document.addEventListener('keydown', e => {
  const row = e.target.closest('.listing-row[data-act=openL]');
  if (!row || e.target !== row || !['Enter', ' '].includes(e.key)) return;
  e.preventDefault();
  actions.openL(row.dataset);
});

// Format currency and phone fields as the user types or pastes a value.
document.addEventListener('input', e => {
  if (e.target.matches('[data-format=currency]')) {
    e.target.value = formatCurrencyInput(e.target.value);
  } else if (e.target.matches('[data-format=phone]')) {
    e.target.value = formatPhone(e.target.value);
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'listing-sort') actions.setListingSort(e.target.value);
});

// When the dialog closes, clean up if it was an unsaved new contact.
dialog.addEventListener('close', () => {
  if (context && context.fresh) {
    db.contacts = db.contacts.filter(c => c.id !== context.id);
    save();
  }
  context = null;
  dialogHistory = [];
});

// Escape follows the same return path as the dialog's close button.
dialog.addEventListener('cancel', e => {
  if (!dialogHistory.length) return;
  e.preventDefault();
  restorePreviousDialog();
});

// Live search: redraw on every keystroke in the search box.
$('#q').addEventListener('input', e => {
  query = e.target.value;
  render();
});

// The big "+" / "Add" button: context-sensitive.
$('#add').addEventListener('click', () =>
  tab === 'listings' ? actions.imp() : actions.newC()
);

// Sync across browser tabs: if another tab writes to localStorage,
// reload our state so we don't overwrite newer data.
window.addEventListener('storage', e => {
  if (e.key === STORAGE_KEY) {
    load();
    render();
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────
// Load saved data and draw the first screen.
load();
render();
