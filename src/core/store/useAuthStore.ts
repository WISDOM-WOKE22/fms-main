import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AdminPermissionKey } from "@/modules/admins/types";

export interface CurrentAdmin {
  id: string;
  name: string;
  email: string;
  role: "super_admin" | "sub_admin";
  status: string;
  permissions: AdminPermissionKey[];
  createdAt: string;
  lastLoginAt?: string;
}

const AUTH_STORAGE_KEY = "fms-auth";
const SESSION_KEY = "fms-session";

interface AuthState {
  admin: CurrentAdmin | null;
  setAdmin: (admin: CurrentAdmin | null) => void;
  logout: () => void;
  /** True if super_admin or sub_admin has the given module permission. */
  canAccess: (permissionKey: AdminPermissionKey) => boolean;
  /** Get initials for avatar (e.g. "JD" for "John Doe"). */
  getInitials: () => string;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      admin: null,
      setAdmin: (admin) => set({ admin }),
      logout: () => {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(SESSION_KEY);
        }
        set({ admin: null });
      },
      canAccess: (permissionKey) => {
        const { admin } = get();
        if (!admin) return false;
        if (admin.role === "super_admin") return true;
        return Array.isArray(admin.permissions) && admin.permissions.includes(permissionKey);
      },
      getInitials: () => {
        const { admin } = get();
        if (!admin?.name?.trim()) return "?";
        const parts = admin.name.trim().split(/\s+/);
        if (parts.length >= 2) {
          return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase().slice(0, 2);
        }
        return admin.name.slice(0, 2).toUpperCase();
      },
    }),
    { name: AUTH_STORAGE_KEY, partialize: (s) => ({ admin: s.admin }) }
  )
);
