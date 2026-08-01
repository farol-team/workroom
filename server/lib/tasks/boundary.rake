namespace :db do
  desc "Apply the boundary between workspaces — the row-level security a schema file cannot carry"
  task boundary: :environment do
    Workspace::Boundary.apply(ActiveRecord::Base.connection)
    puts "Boundary applied: #{Workspace::Boundary::ROOMS.size} tables, role #{Workspace::APP_ROLE}."
  end
end
