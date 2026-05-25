import { cookies } from "next/headers";

export const authRouteInternals = {
  getCookieStore: cookies,
};

export const logoutRouteInternals = {
  getCookieStore: cookies,
};
