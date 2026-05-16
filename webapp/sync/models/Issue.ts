import {
  BaseModel,
  ClientModel,
  Property,
  Reference,
  Action,
  Computed,
  LoadStrategy,
} from "sync-engine";
import type { Team } from "./Team";
import { dateSerializer, dateDeserializer } from "./serializers";

@ClientModel({ name: "Issue", loadStrategy: LoadStrategy.Eager, usedForPartialIndexes: true })
export class Issue extends BaseModel {
  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public createdAt: Date = new Date();

  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public updatedAt: Date = new Date();

  @Property()
  public title = "";

  @Property()
  public description = "";

  @Property()
  public priority = 0;

  @Property()
  public sortOrder = 0;

  @Property({ indexed: true })
  public teamId: string | null = null;

  @Reference("Team", { onDelete: "cascade" })
  public team: Team;

  @Action moveToTeam(newTeamId: string) {
    this.teamId = newTeamId;
  }

  @Computed get identifier() {
    return `${(this.teamId ?? "").slice(0, 4)}-${this.sortOrder}`;
  }
}
