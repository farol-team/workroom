class CreateUsers < ActiveRecord::Migration[8.1]
  def change
    create_table :users do |t|
      t.string :email,      null: false
      t.string :name
      t.string :avatar_url
      t.string :provider,   null: false   # omniauth: entra, google, ...
      t.string :uid,        null: false
      t.timestamps
    end
    add_index :users, :email, unique: true
    add_index :users, [ :provider, :uid ], unique: true
  end
end
