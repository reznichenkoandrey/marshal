export type DesktopBackendMethod =
  | "getHealth"
  | "listProjects"
  | "createProject"
  | "listSessions"
  | "createSession"
  | "readSession"
  | "deleteSession"
  | "submitTask"
  | "getSessionPaths";

export type DesktopBackendRequest = {
  kind: "invoke";
  id: string;
  method: DesktopBackendMethod;
  params: unknown[];
};

export type DesktopBackendSuccess = {
  kind: "success";
  id: string;
  result: unknown;
};

export type DesktopBackendFailure = {
  kind: "failure";
  id: string;
  error: string;
};

export type DesktopBackendResponse = DesktopBackendSuccess | DesktopBackendFailure;
