import { BaseModel, ClientModel, Property, LazyReferenceCollection, LoadStrategy } from "sync-engine";
import type { RefCollection } from "sync-engine";
import type { Issue } from "./Issue";
import { dateSerializer, dateDeserializer } from "./serializers";

@ClientModel({ name: "Team", loadStrategy: LoadStrategy.Eager })
export class Team extends BaseModel {
  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public createdAt: Date = new Date();

  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public updatedAt: Date = new Date();

  @Property()
  public name = "";

  @Property()
  public key = "";

  @LazyReferenceCollection("Issue")
  public issues: RefCollection<Issue>;
}
