require "test_helper"

# The store was chosen by whether one variable happened to be set, and a
# production server deployed without it accumulated what every room knows in
# PostgreSQL without saying so. That happened — the first deploy of this server
# came up exactly that way, and was caught by looking rather than by being told.
#
# The fallback itself is right: it is why bin/prototype runs with no credentials
# and why the suite runs in CI against no external service. What was wrong is
# that production could not tell "PostgreSQL was chosen" from "the variable was
# forgotten".
class MemoryStoreConfigTest < ActiveSupport::TestCase
  # The initializer runs under to_prepare with the real environment, so the
  # decision is extracted and exercised directly. Testing it through boot would
  # mean booting a second application per case.
  def choose(env)
    Memory::Selection.new(env).store_class
  end

  test "a context store is used when one is configured" do
    %w[development production].each do |rails_env|
      assert_equal Memory::OpenViking,
        choose("RAILS_ENV" => rails_env, "OPENVIKING_URL" => "http://context:8000"),
        "#{rails_env} must use the configured context store"
    end
  end

  test "outside production, no context store is PostgreSQL and that is the point" do
    %w[development test].each do |rails_env|
      assert_equal Memory::Local, choose("RAILS_ENV" => rails_env),
        "#{rails_env} must fall back — bin/prototype runs with no credentials, and CI has no store"
    end
  end

  test "a production server that forgets its context store refuses to start" do
    error = assert_raises(RuntimeError) { choose("RAILS_ENV" => "production") }

    assert_match "OPENVIKING_URL", error.message,
      "the refusal must name the variable that is missing, or it sends somebody reading source"
    assert_match "WORKROOM_MEMORY_IN_POSTGRES", error.message,
      "and name the way out, or the only way to deploy without a store is to guess"
  end

  test "choosing PostgreSQL in production is possible only by saying so" do
    assert_equal Memory::Local,
      choose("RAILS_ENV" => "production", "WORKROOM_MEMORY_IN_POSTGRES" => "true"),
      "an operator who means it must be able to say so"

    assert_raises(RuntimeError) do
      choose("RAILS_ENV" => "production", "WORKROOM_MEMORY_IN_POSTGRES" => "1")
    end
    assert_raises(RuntimeError) do
      choose("RAILS_ENV" => "production", "WORKROOM_MEMORY_IN_POSTGRES" => "yes")
    end
  end

  test "building an image is not booting a server" do
    # Precompiling assets loads the production environment inside the image,
    # where no store is configured and none can be. Rails marks that case with
    # SECRET_KEY_BASE_DUMMY — the difference between an image that cannot be
    # built and a server that will not start misconfigured.
    assert_equal Memory::Local,
      choose("RAILS_ENV" => "production", "SECRET_KEY_BASE_DUMMY" => "1"),
      "asset precompilation must not require a context store"
  end
end
