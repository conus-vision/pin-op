export const BadgeAction = Object.freeze({DOM_ELEMENT_OR_ATTRIBUTE_EDITED: 0, MODERN_DOM_BADGE_CLICKED: 1});
export class UserBadges {
  static instance(): UserBadges { return new UserBadges(); }
  recordAction(_action: unknown): void {}
}
