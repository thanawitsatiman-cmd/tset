function personIdentityKey(name, phone, address) {
  const normalizeText = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const normalizePhone = value => String(value || '').replace(/[^0-9]/g, '');
  return [
    normalizeText(name),
    normalizePhone(phone),
    normalizeText(address)
  ].join('\u001f');
}

module.exports = { personIdentityKey };
