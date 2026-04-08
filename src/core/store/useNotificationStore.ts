import { create } from "zustand";

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  createdAt: Date;
  read: boolean;
}

interface NotificationState {
  notifications: AppNotification[];
  selectedId: string | null;
  setNotifications: (list: AppNotification[]) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  setSelectedId: (id: string | null) => void;
  openNotification: (n: AppNotification) => void;
  closeDetail: () => void;
}

function createDemoNotifications(): AppNotification[] {
  const now = Date.now();
  const minutesAgo = (mins: number) => new Date(now - mins * 60 * 1000);

  return [
    {
      id: "notif-normal-1",
      title: "Welcome to FMS",
      message: "Your notification center is active and ready for daily operations updates.",
      createdAt: minutesAgo(2),
      read: false,
    },
    {
      id: "notif-update-1",
      title: "System Update Available",
      message: "Version 2.3.1 is available with dashboard performance improvements and bug fixes.",
      createdAt: minutesAgo(15),
      read: false,
    },
    {
      id: "notif-maintenance-1",
      title: "Planned Maintenance Window",
      message: "Scheduled maintenance starts tonight at 11:30 PM and may affect syncing for 20 minutes.",
      createdAt: minutesAgo(45),
      read: false,
    },
    {
      id: "notif-license-1",
      title: "License Expiry Reminder",
      message: "Your organization license expires in 14 days. Renew now to avoid service interruption.",
      createdAt: minutesAgo(120),
      read: false,
    },
    {
      id: "notif-contract-1",
      title: "New Contract Added",
      message: "A new service contract was created for ACME Distribution with start date next Monday.",
      createdAt: minutesAgo(180),
      read: true,
    },
    {
      id: "notif-issue-1",
      title: "Issue Detected",
      message: "Camera feed interruption detected in Warehouse A. Last heartbeat received 8 minutes ago.",
      createdAt: minutesAgo(240),
      read: false,
    },
    {
      id: "notif-security-1",
      title: "Unusual Access Pattern",
      message: "Three failed check-in attempts were detected at the North Wing gate within 5 minutes.",
      createdAt: minutesAgo(360),
      read: false,
    },
    {
      id: "notif-normal-2",
      title: "Shift Summary Ready",
      message: "Morning shift attendance summary is now available in reports.",
      createdAt: minutesAgo(550),
      read: true,
    },
    {
      id: "notif-update-2",
      title: "Feature Update",
      message: "Notification details popup now supports improved readability for long messages.",
      createdAt: minutesAgo(780),
      read: true,
    },
    {
      id: "notif-maintenance-2",
      title: "Maintenance Completed",
      message: "Database maintenance completed successfully. All services are operating normally.",
      createdAt: minutesAgo(1300),
      read: true,
    },
    {
      id: "notif-license-2",
      title: "License Renewed",
      message: "Your enterprise license renewal has been confirmed and is active until next year.",
      createdAt: minutesAgo(1650),
      read: true,
    },
    {
      id: "notif-contract-2",
      title: "Contract Approval Needed",
      message: "Contract renewal for Delta Logistics requires your approval before end of day.",
      createdAt: minutesAgo(2100),
      read: false,
    },
    {
      id: "notif-issue-2",
      title: "Issue Resolved",
      message: "Connectivity restored for Lobby camera. Monitoring has returned to normal status.",
      createdAt: minutesAgo(2880),
      read: true,
    },
  ];
}

export function formatNotificationTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: createDemoNotifications(),
  selectedId: null,

  setNotifications: (list) => set({ notifications: list }),

  markAsRead: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      ),
    })),

  markAllAsRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
    })),

  setSelectedId: (id) => set({ selectedId: id }),

  openNotification: (n) =>
    set((state) => ({
      selectedId: n.id,
      notifications: state.notifications.map((x) =>
        x.id === n.id ? { ...x, read: true } : x
      ),
    })),

  closeDetail: () => set({ selectedId: null }),
}));
