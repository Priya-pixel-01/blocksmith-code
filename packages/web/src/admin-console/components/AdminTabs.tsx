import type { ReactNode } from 'react';

import type { AdminTabKey } from '../adminConsole.types';

type TabProps = {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
};

function Tab({ active, onClick, children }: TabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`admin-console__tab ${active ? 'admin-console__tab--active' : ''}`}
    >
      {children}
    </button>
  );
}

type AdminTabsProps = {
  activeTab: AdminTabKey;
  onTabChange: (tab: AdminTabKey) => void;
};

export function AdminTabs({ activeTab, onTabChange }: AdminTabsProps) {
  const tabs: Array<{ key: AdminTabKey; label: string }> = [
    { key: 'users', label: 'Users' },
    { key: 'projects', label: 'Projects' },
    { key: 'apiKeys', label: 'API Keys' },
    { key: 'tools', label: 'Tools' },
    { key: 'auditLogs', label: 'Audit Logs' },
  ];

  return (
    <div className="admin-console__tabs" role="tablist" aria-label="Admin sections">
      {tabs.map((tab) => (
        <Tab
          key={tab.key}
          active={activeTab === tab.key}
          onClick={() => onTabChange(tab.key)}
        >
          <span className="flex items-center gap-2">
            {tab.label}
          </span>
        </Tab>
      ))}
    </div>
  );
}

