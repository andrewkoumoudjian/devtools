import React, { useEffect, useState } from 'react';
import { Button, Heading } from '@primer/react';
import { BellIcon, CheckIcon } from '@primer/octicons-react';
import type { Notification } from './model';
import { execute, navigate, repoPath } from './api';

export function NotificationsTab({ owner, repo }: { owner: string; repo: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function load() {
    setNotifications(await execute<Notification[]>('notification.list', { owner, repo, unreadOnly, limit: 200 }));
  }

  useEffect(() => { void load().catch(setError); }, [owner, repo, unreadOnly]);

  async function markRead(item: Notification) {
    try {
      await execute('notification.read', { owner, repo, id: item.id });
      await load();
    } catch (cause) { setError(cause); }
  }

  function openTarget(item: Notification) {
    if (item.target_kind === 'pull' && item.target_number) navigate(repoPath(owner, repo, `/pulls/${item.target_number}`));
  }

  const unread = notifications.filter((item) => !item.read_at).length;
  return <section>{error ? <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div> : null}<div className="forge-code-toolbar"><div><Heading as="h2">Notifications</Heading><div className="forge-page-subtitle">Repository activity emitted from the same context event graph agents consume.</div></div><Button leadingVisual={BellIcon} onClick={() => setUnreadOnly((value) => !value)}>{unreadOnly ? 'Show all' : `Unread${unread ? ` (${unread})` : ''}`}</Button></div><div className="forge-card">{notifications.length === 0 ? <div className="forge-empty">No notifications.</div> : notifications.map((item) => <div className={`forge-notification ${item.read_at ? 'forge-notification-read' : ''}`} key={item.id}><button className="forge-notification-main" onClick={() => openTarget(item)}><BellIcon /><span><strong>{item.title}</strong>{item.body ? <span className="forge-notification-body">{item.body}</span> : null}<span className="forge-list-meta">{item.kind} · {item.created_at}</span></span></button>{!item.read_at ? <Button leadingVisual={CheckIcon} onClick={() => void markRead(item)}>Mark read</Button> : <span className="forge-muted">Read</span>}</div>)}</div></section>;
}
