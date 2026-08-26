/** Subset of the Google Calendar v3 wire format that this integration uses. */

export interface GoogleDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleAttendee {
  email?: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
}

export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  created?: string;
  updated?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleDateTime;
  transparency?: 'opaque' | 'transparent';
  attendees?: GoogleAttendee[];
  organizer?: GoogleAttendee;
  creator?: GoogleAttendee;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  conferenceData?: unknown;
  eventType?: string;
}

export interface GoogleEventsResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
  timeZone?: string;
}

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  timeZone?: string;
  primary?: boolean;
  accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
  backgroundColor?: string;
  deleted?: boolean;
}

export interface GoogleCalendarListResponse {
  items?: GoogleCalendarListEntry[];
  nextPageToken?: string;
}

export interface GoogleUserInfo {
  email?: string;
  name?: string;
}
