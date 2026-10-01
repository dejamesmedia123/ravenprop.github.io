import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
import MetaTrader5 as mt5
API_URL = os.environ.get('RAVEN_API_URL', '')
SECRET = os.environ.get('EQUITY_SECRET', '')
BATCH = 50

def post(action, payload):
    body = json.dumps({'action': action, 'payload': dict(payload, secret=SECRET)}).encode()
    req = urllib.request.Request(API_URL, data=body, headers={'Content-Type': 'text/plain;charset=utf-8'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

def read_account(acct):
    if not mt5.login(int(acct['login']), password=acct['investor_password'], server=acct['server']):
        return None
    info = mt5.account_info()
    if info is None:
        return None
    now = datetime.now(timezone.utc)
    deals = mt5.history_deals_get(now - timedelta(days=90), now + timedelta(days=1)) or []
    trades = [d.time for d in deals if d.type in (0, 1)]
    return {'login': str(acct['login']), 'balance': info.balance, 'equity': info.equity, 'timestamp': now.isoformat(), 'last_trade': datetime.fromtimestamp(max(trades), timezone.utc).isoformat() if trades else '', 'open_positions': mt5.positions_total() or 0}

def main():
    if not API_URL or not SECRET:
        print('RAVEN_API_URL and EQUITY_SECRET must be set.')
        return 1
    res = post('equity.accounts', {})
    if not res.get('ok'):
        print('Could not fetch accounts:', res.get('error'))
        return 1
    accounts = res['data']['accounts']
    if not accounts:
        print('No accounts to read.')
        return 0
    path = os.environ.get('MT5_PATH', '')
    first = accounts[0]
    kw = dict(login=int(first['login']), password=first['investor_password'], server=first['server'], timeout=120000)
    if path:
        kw['path'] = path
    ok = False
    for attempt in range(3):
        if mt5.initialize(**kw):
            ok = True
            break
        print('MT5 init attempt', attempt + 1, 'failed:', mt5.last_error())
        mt5.shutdown()
        # a bad login must not block start-up; start the bare terminal and let each account log in on its own
        bare = {k: v for k, v in kw.items() if k in ('path', 'timeout')}
        if mt5.initialize(**bare):
            ok = True
            break
        print('MT5 bare start failed:', mt5.last_error())
        mt5.shutdown()
        time.sleep(20)
    if not ok:
        print('MetaTrader 5 did not start:', mt5.last_error())
        return 1
    rows, failed = ([], [])
    for a in accounts:
        row = read_account(a)
        (rows if row else failed).append(row or a['login'])
    mt5.shutdown()
    totals = {'updated': 0, 'passed': 0, 'breached': 0}
    for i in range(0, len(rows), BATCH):
        out = post('equity.ingest', {'rows': rows[i:i + BATCH]})
        if not out.get('ok'):
            print('Upload failed:', out.get('error'))
            return 1
        for k in totals:
            totals[k] += out['data'].get(k, 0)
    print('Accounts:', len(accounts), 'read:', len(rows), 'failed login:', len(failed), totals)
    if failed:
        print('Could not read logins:', ', '.join(failed))
    return 0 if rows or not accounts else 1
if __name__ == '__main__':
    sys.exit(main())
