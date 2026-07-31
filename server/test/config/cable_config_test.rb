require "test_helper"

# Broadcasts are the product. Three ways this quietly stops being true, all of
# them invisible until someone opens a second window in production.
class CableConfigTest < ActiveSupport::TestCase
  ROOT  = Rails.root
  CABLE = YAML.load_file(ROOT.join("config/cable.yml"), aliases: true)

  test "broadcasts go through the database, not Redis, wherever it runs for real" do
    %w[development production].each do |env|
      assert_equal "solid_cable", CABLE.fetch(env)["adapter"],
        "#{env} must broadcast through Solid Cable — async loses a second process, Redis is a dependency we do not take"
      assert_equal "cable", CABLE.fetch(env).dig("connects_to", "database", "writing"),
        "#{env} must write cable messages to the cable database"
    end
  end

  test "the cable database is defined by its own schema and holds one table" do
    schema = ROOT.join("db/cable_schema.rb").read
    tables = schema.scan(/create_table "(\w+)"/).flatten
    assert_equal %w[solid_cable_messages], tables,
      "cable_schema.rb defines the cable database; app tables in it mean a dump captured a polluted database"
  end

  test "app migrations cannot reach the cable database" do
    db = YAML.load_file(ROOT.join("config/database.yml"), aliases: true)
    %w[development production].each do |env|
      assert_equal "db/cable_migrate", db.fetch(env).fetch("cable")["migrations_paths"],
        "without its own migrations_paths the cable database inherits db/migrate and grows the whole app schema"
    end
  end
end
