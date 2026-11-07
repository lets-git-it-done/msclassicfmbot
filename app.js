let rows = [];
let sort = 'profitPct';
let direction = -1;
let groupByRoom = false;
let minimumTotalProfit = null;
const soldListings = new Set();

const query = selector => document.querySelector(selector);
const format = value => Math.round(value).toLocaleString();
const dialog = query('#dialog');
const cookieInput = query('#cookieHeader');
let nextRefresh = 60;
let serverInstanceId = null;

function calculate(listing) {
  const result = { ...listing };
  result.profit = result.npcValue - result.unitPrice;
  result.profitPct = result.profit / result.unitPrice * 100;
  result.total = result.profit * result.quantity;
  return result;
}

function listingKey(listing) {
  return JSON.stringify([
    listing.storeId,
    listing.itemId,
    listing.seller,
    listing.channel,
    listing.room,
    listing.quantity,
    listing.unitPrice
  ]);
}

function renderListingRow(listing) {
  return `<tr>` +
    `<td class="item">${listing.icon} ${listing.item}<span class="sub">ID ${listing.itemId}</span></td>` +
    `<td>${format(listing.quantity)}</td>` +
    `<td>${format(listing.unitPrice)}<span class="sub">mesos</span></td>` +
    `<td>${format(listing.npcValue)}<span class="sub">mesos</span></td>` +
    `<td class="profit ${listing.profit <= 0 ? 'bad' : ''}">${listing.profit > 0 ? '+' : ''}${format(listing.profit)}</td>` +
    `<td class="profit ${listing.total <= 0 ? 'bad' : ''}">${listing.total > 0 ? '+' : ''}${format(listing.total)}<span class="sub">mesos</span></td>` +
    `<td><span class="pill ${listing.profit <= 0 ? 'bad' : ''}">${listing.profit > 0 ? '+' : ''}${listing.profitPct.toFixed(1)}%</span></td>` +
    `<td>${listing.seenAt}</td>` +
    `<td><b>${listing.seller}</b><span class="sub">Ch. ${listing.channel} · Room ${listing.room}</span></td>` +
    `<td><button class="sold-button" data-listing-index="${listing.sourceIndex}" type="button">Mark sold</button></td>` +
  `</tr>`;
}

function updateMinimumProfitDisplay() {
  query('#minTotalProfitValue').textContent = minimumTotalProfit === null
    ? 'Any'
    : `${format(minimumTotalProfit)} mesos`;
}

function renderListings() {
  const term = query('#search').value.toLowerCase();
  const profitFilter = query('#profitFilter').value;
  const channelFilter = query('#channelFilter').value;
  updateMinimumProfitDisplay();
  const visibleRows = rows
    .map((listing, sourceIndex) => ({
      ...calculate(listing),
      sourceIndex
    }))
    .filter(listing =>
      (!term || `${listing.item} ${listing.seller} ${listing.channel} ${listing.room}`.toLowerCase().includes(term)) &&
      (
        profitFilter === 'all' ||
        (profitFilter === 'positive' && listing.profit > 0) ||
        (profitFilter === 'loss' && listing.profit <= 0)
      ) &&
      (channelFilter === 'all' || listing.channel == channelFilter) &&
      (minimumTotalProfit === null || listing.total >= minimumTotalProfit)
    );

  visibleRows.sort((left, right) =>
    typeof left[sort] === 'string'
      ? direction * left[sort].localeCompare(right[sort])
      : direction * (left[sort] - right[sort])
  );

  const profitable = rows.map(calculate).filter(listing => listing.profit > 0);
  const best = [...profitable].sort((a, b) => b.profitPct - a.profitPct)[0];
  query('#stats').innerHTML =
    `<article class="stat"><small>ACTIVE LISTINGS</small><b>${rows.length}</b></article>` +
    `<article class="stat"><small>PROFITABLE FINDS</small><b class="green">${profitable.length}</b></article>` +
    `<article class="stat"><small>BEST PROFIT RATE</small><b class="green">${best ? best.profitPct.toFixed(1) : 0}%</b></article>` +
    `<article class="stat"><small>EST. TOTAL UPSIDE</small><b>${format(profitable.reduce((sum, listing) => sum + listing.total, 0))} mesos</b></article>`;
  query('#resultCount').textContent =
    `${visibleRows.length} listing${visibleRows.length === 1 ? '' : 's'} · sorted by ${sort === 'profitPct' ? 'profit %' : sort}`;
  if (!groupByRoom) {
    query('#rows').innerHTML = visibleRows.map(renderListingRow).join('');
  } else {
    const roomGroups = new Map();
    const otherListings = [];
    for (const listing of visibleRows) {
      if (listing.profit <= 0) {
        otherListings.push(listing);
        continue;
      }

      const room = listing.room ?? 'Unknown';
      if (!roomGroups.has(room)) {
        roomGroups.set(room, { room, listings: [], potential: 0 });
      }
      const group = roomGroups.get(room);
      group.listings.push(listing);
      group.potential += listing.total;
    }

    const groupedRows = [...roomGroups.values()]
      .sort((left, right) => right.potential - left.potential)
      .map(group =>
        `<tr class="room-group"><th colspan="10" scope="rowgroup">Room ${group.room} · ` +
        `${group.listings.length} profitable listing${group.listings.length === 1 ? '' : 's'} · ` +
        `${format(group.potential)} mesos potential ` +
        `<button class="sold-button room-sold-button" data-room-key="${encodeURIComponent(String(group.room))}" type="button">` +
        `Mark room sold</button></th></tr>` +
        group.listings.map(renderListingRow).join('')
      );

    if (otherListings.length) {
      groupedRows.push(
        `<tr class="room-group"><th colspan="10" scope="rowgroup">Non-profitable listings</th></tr>` +
        otherListings.map(renderListingRow).join('')
      );
    }
    query('#rows').innerHTML = groupedRows.join('');
  }
  query('#empty').textContent = rows.length
    ? 'No listings match those filters.'
    : 'No listings loaded yet. Refresh data to pull listings.';
  query('#empty').hidden = visibleRows.length > 0;
}

function updateChannels() {
  const channels = [...new Set(rows.map(listing => listing.channel))]
    .sort((left, right) => left - right);
  query('#channelFilter').innerHTML =
    '<option value="all">All channels</option>' +
    channels.map(channel => `<option value="${channel}">Channel ${channel}</option>`).join('');
}

function showCookiePrompt(message) {
  if (!dialog.open) dialog.showModal();
  query('#message').textContent = message;
  cookieInput.focus();
}

async function loadFeed() {
  const message = query('#message');
  let serverRestarted = false;
  message.textContent = 'Checking Live Feed...';

  try {
    const cookieHeader = cookieInput.value.trim();
    const cookieWasSubmitted = Boolean(cookieHeader);
    if (cookieHeader) {
      const sessionResponse = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookieHeader })
      });
      const sessionResult = await sessionResponse.json();
      if (!sessionResponse.ok) {
        throw new Error(sessionResult.error || 'Could not save the Cookie header.');
      }
      cookieInput.value = '';
    }

    const response = await fetch('/api/live-feed');
    const data = await response.json();
    const responseInstanceId = response.headers.get('X-Server-Instance');
    if (responseInstanceId && serverInstanceId && responseInstanceId !== serverInstanceId) {
      serverRestarted = true;
      rows = [];
      updateChannels();
      renderListings();
      query('#updated').textContent = 'Server restarted - starting a new session';
    }
    if (responseInstanceId) serverInstanceId = responseInstanceId;

    if (!response.ok) {
      if (data.needsCookie) showCookiePrompt(data.error);
      throw new Error(data.error || 'Live Feed unavailable');
    }

    if (cookieWasSubmitted) closeCookiePrompt();

    const incoming = Array.isArray(data.listings) ? data.listings : [];
    const knownListings = new Set(rows.map(listingKey));
    const newListings = incoming.filter(listing => {
      const key = listingKey(listing);
      if (soldListings.has(key) || knownListings.has(key)) return false;
      knownListings.add(key);
      return true;
    });

    rows = rows.concat(newListings);
    updateChannels();
    renderListings();
    query('#updated').textContent = 'Live Feed updated just now';
    message.textContent = newListings.length
      ? `Added ${newListings.length} new listings. ${rows.length} total in this session.`
      : `No new listings. ${rows.length} total in this session.`;
  } catch (error) {
    query('#updated').textContent = serverRestarted
      ? 'Server restarted - waiting for new listings'
      : rows.length
        ? 'Live Feed unavailable - showing last snapshot'
        : 'Live Feed unavailable';
    message.textContent = `Refresh unavailable: ${error.message}${rows.length
      ? '. Prior snapshot unchanged.'
      : '. No listings have been loaded.'}`;
  }
}

function updateCountdown() {
  query('#countdown').textContent =
    `Next refresh in ${Math.floor(nextRefresh / 60)}:${String(nextRefresh % 60).padStart(2, '0')}`;
  if (nextRefresh-- <= 0) {
    nextRefresh = 60;
    loadFeed();
  }
}

document.querySelectorAll('th').forEach(header => {
  header.onclick = () => {
    const key = header.dataset.key;
    if (!key) return;
    direction = sort === key ? -direction : (key === 'item' || key === 'seller' ? 1 : -1);
    sort = key;
    renderListings();
  };
});

['search', 'profitFilter', 'channelFilter'].forEach(id => {
  query(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change', renderListings);
});

query('#clear').onclick = () => {
  query('#search').value = '';
  query('#profitFilter').value = 'all';
  query('#channelFilter').value = 'all';
  minimumTotalProfit = null;
  query('#minTotalProfit').value = '';
  renderListings();
};

query('#minTotalProfit').addEventListener('input', event => {
  const value = event.currentTarget.value;
  minimumTotalProfit = value === '' ? null : Number(value);
  renderListings();
});

query('#groupByRoom').addEventListener('change', event => {
  groupByRoom = event.currentTarget.checked;
  renderListings();
});

query('#rows').addEventListener('click', event => {
  const roomButton = event.target.closest('button[data-room-key]');
  if (roomButton) {
    const room = decodeURIComponent(roomButton.dataset.roomKey);
    const soldInRoom = rows.filter(listing =>
      String(listing.room ?? 'Unknown') === room && calculate(listing).profit > 0
    );
    if (!soldInRoom.length) return;

    for (const listing of soldInRoom) soldListings.add(listingKey(listing));
    rows = rows.filter(listing =>
      String(listing.room ?? 'Unknown') !== room || calculate(listing).profit <= 0
    );
    updateChannels();
    renderListings();
    query('#message').textContent =
      `Marked ${soldInRoom.length} profitable listing${soldInRoom.length === 1 ? '' : 's'} in Room ${room} sold.`;
    return;
  }

  const button = event.target.closest('button[data-listing-index]');
  if (!button) return;

  const sourceIndex = Number(button.dataset.listingIndex);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= rows.length) return;

  const [soldListing] = rows.splice(sourceIndex, 1);
  soldListings.add(listingKey(soldListing));
  updateChannels();
  renderListings();
  query('#message').textContent = `${soldListing.item} marked sold and removed from the table.`;
});

query('#refresh').onclick = () => {
  showCookiePrompt('Paste a Cookie header, or leave it blank to reuse the current in-memory session.');
};

function closeCookiePrompt() {
  cookieInput.value = '';
  dialog.close();
}

query('#close').onclick = closeCookiePrompt;
query('#cancel').onclick = closeCookiePrompt;
query('#run').onclick = loadFeed;

setInterval(updateCountdown, 1000);
updateCountdown();
updateChannels();
renderListings();
loadFeed();
