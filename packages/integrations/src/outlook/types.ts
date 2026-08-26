/** Subset of the Microsoft Graph calendar wire format used by this integration. */

export interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphAttendee {
  type?: 'required' | 'optional' | 'resource';
  status?: { response?: string; time?: string };
  emailAddress?: GraphEmailAddress;
}

export interface GraphExtendedProperty {
  id: string;
  value: string;
}

export interface GraphEvent {
  id: string;
  '@odata.etag'?: string;
  '@removed'?: { reason?: string };
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown';
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  seriesMasterId?: string;
  recurrence?: unknown;
  responseStatus?: { response?: string };
  attendees?: GraphAttendee[];
  organizer?: { emailAddress?: GraphEmailAddress };
  isOrganizer?: boolean;
  location?: { displayName?: string };
  onlineMeeting?: unknown;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  singleValueExtendedProperties?: GraphExtendedProperty[];
}

export interface GraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export interface GraphCalendar {
  id: string;
  name?: string;
  canEdit?: boolean;
  isDefaultCalendar?: boolean;
  hexColor?: string;
  owner?: GraphEmailAddress;
}

export interface GraphUser {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

export interface GraphMailboxSettings {
  timeZone?: string;
}
